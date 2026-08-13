# Debian 13 (Trixie) carries the vendor security backports for giflib that are
# still missing from Alpine 3.23. Keep the Node major stable for this release,
# but pin the distribution so package provenance does not change silently.
FROM node:22-trixie-slim AS dependencies

WORKDIR /app

# Production dependencies (cached layer). The lockfile is copied too so installs
# are reproducible across dev / CI / production.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-trixie-slim

WORKDIR /app

# Pull all Debian security updates before installing the OCR/PDF runtime. The
# installed giflib package must include Debian's CVE-2026-23868/26740 backport.
# Direct-Xfer only invokes tesseract, pdftotext and pdftoppm; pdftocairo and the
# Tesseract training renderer text2image are removed because their Cairo paths
# are unnecessary and are the only paths relevant to CVE-2025-50422 here.
# npm/corepack are build tools, not runtime dependencies; removing them from the
# final image drops their global dependency tree and its avoidable CVE surface.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    gosu \
    poppler-utils \
    rclone \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-fra \
    tesseract-ocr-spa \
  && giflib_version="$(dpkg-query -W -f='${Version}' libgif7)" \
  && dpkg --compare-versions "$giflib_version" ge '5.2.2-1+deb13u1' \
  && mkdir -p /usr/share/doc/direct-xfer \
  && dpkg-query -W -f='${Package}\t${Version}\n' \
    libcairo2 libgif7 libnss3 poppler-utils rclone tesseract-ocr \
    > /usr/share/doc/direct-xfer/os-packages.tsv \
  && rm -f /usr/bin/pdftocairo /usr/bin/text2image \
  && test ! -e /usr/bin/pdftocairo \
  && test ! -e /usr/bin/text2image \
  && tesseract --version >/dev/null \
  && pdftotext -v >/dev/null 2>&1 \
  && pdftoppm -v >/dev/null 2>&1 \
  && rclone version >/dev/null \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/yarn \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# Application code: a single server file + the web interface + the companion PWA
COPY server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
COPY pwa ./pwa
COPY security/openvex.json /usr/share/doc/direct-xfer/openvex.json

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
  '  exec gosu "$PUID:$PGID" "$@"' \
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
# unprivileged 'node' user via gosu. `docker-entrypoint.sh` never runs
# untrusted code as root and `node server.js` itself always ends up running as
# 'node', not root — a static USER directive would break the chown step on
# fresh/host-owned bind mounts. Verified at runtime: `docker exec <container> id`
# reports uid=1000(node).
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["node", "server.js"]
