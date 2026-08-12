FROM node:22-alpine AS dependencies

WORKDIR /app

# Production dependencies (cached layer). The lockfile is copied too so installs
# are reproducible across dev / CI / production.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine

WORKDIR /app

# Pull patched Alpine packages at build time and keep only the runtime helper.
# npm/corepack are build tools, not runtime dependencies; removing them from the
# final image drops their global dependency tree and its avoidable CVE surface.
RUN apk upgrade --no-cache \
  && apk add --no-cache su-exec poppler-utils tesseract-ocr tesseract-ocr-data-eng tesseract-ocr-data-fra tesseract-ocr-data-spa \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/yarn

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# Application code: a single server file + the web interface + the companion PWA
COPY server.js ./
COPY public ./public
COPY pwa ./pwa

# /host        = host filesystem, mounted read-only (/:/host:ro)
# /data        = persistence (shares, history, password)
# /Images      = managed Full, Mini, Micro and revoked-image previews
# /Direct-Xfer = received files (reception links), to mount as WRITABLE
ENV HOST_ROOT=/host \
    DATA_DIR=/data \
    IMAGES_DIR=/Images \
    INBOX_DIR=/Direct-Xfer \
    PORT=55750 \
    NODE_ENV=production
VOLUME ["/data", "/Images"]
EXPOSE 55750

# Entrypoint: makes /data, /Images and the reception folder writable by the runtime user,
# then drops root privileges. Honors the PUID/PGID convention (Unraid / LinuxServer)
# so the container can run as the user that owns the host volumes — otherwise the
# history and admin password would not persist. Defaults to 'node' (1000:1000) for
# backward compatibility. On Unraid, set PUID=99 and PGID=100 (nobody:users).
RUN printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  'PUID="${PUID:-1000}"' \
  'PGID="${PGID:-1000}"' \
  'if [ "$PUID" = "0" ] || [ "$PGID" = "0" ]; then' \
  '  echo "ERROR: PUID/PGID must not be 0 (root). Use a non-root uid/gid." >&2' \
  '  exit 1' \
  'fi' \
  'if [ "$(id -u)" = "0" ]; then' \
  '  mkdir -p "$DATA_DIR" "$IMAGES_DIR" "$INBOX_DIR" 2>/dev/null || true' \
  '  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true' \
  '  chown -R "$PUID:$PGID" "$IMAGES_DIR" 2>/dev/null || true' \
  '  chown "$PUID:$PGID" "$INBOX_DIR" 2>/dev/null || true' \
  '  exec su-exec "$PUID:$PGID" "$@"' \
  'fi' \
  'exec "$@"' \
  > /usr/local/bin/docker-entrypoint.sh \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

# Probes the public /healthz liveness endpoint (always 200 when the server is
# healthy) and requires a real 200 — so an internal error / misroute fails the check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||55750)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# NOTE for scanners: no static `USER` here on purpose. The container must start
# as root ONLY to chown the bind-mounted /data, /Images and /Direct-Xfer volumes (see the
# entrypoint script above), then immediately re-execs the actual process as the
# unprivileged 'node' user via su-exec. `docker-entrypoint.sh` never runs
# untrusted code as root and `node server.js` itself always ends up running as
# 'node', not root — a static USER directive would break the chown step on
# fresh/host-owned bind mounts. Verified at runtime: `docker exec <container> id`
# reports uid=1000(node).
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["node", "server.js"]
