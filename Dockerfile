# Debian 13 (Trixie) carries the vendor security backports for giflib that are
# still missing from Alpine 3.23. Keep the Node major stable for this release,
# but pin the distribution so package provenance does not change silently.
# The rclone toolchain is pinned more strictly because its Go stdlib is copied
# into the final binary and therefore becomes part of the runtime attack surface.
ARG DX_RCLONE_BUILD_VERSION=v1.75.0
ARG DX_RCLONE_GO_BUILD_VERSION=1.25.14
ARG DX_RCLONE_X_IMAGE_VERSION=v0.45.0
ARG DX_TESSERACT_BUILD_VERSION=5.5.3
ARG DX_TESSERACT_BUILD_COMMIT=db0ec62f81b0737fbbe184d8fea40af5738f8eef
FROM golang:${DX_RCLONE_GO_BUILD_VERSION}-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS rclone-builder
ARG DX_RCLONE_BUILD_VERSION
ARG DX_RCLONE_GO_BUILD_VERSION
ARG DX_RCLONE_X_IMAGE_VERSION

# Debian Trixie still ships an old rclone built with a vulnerable Go stdlib.
# Build the pinned rclone release with a patched Go toolchain. Verification uses
# Go's machine-readable binary metadata instead of parsing rclone's human-facing
# version report, whose formatting is not an API and must never break the image.
# IMPORTANT: do not name Docker build args RCLONE_VERSION/RCLONE_*: rclone imports
# RCLONE_* environment variables as CLI flags, and RCLONE_VERSION=v1.75.0 is
# interpreted as the boolean --version flag, which makes every rclone invocation fail.
# GOTOOLCHAIN=local forbids an implicit toolchain download.
ENV GOTOOLCHAIN=local \
    GOSUMDB=sum.golang.org \
    GOPROXY=https://proxy.golang.org,direct \
    GODEBUG=http2client=0
RUN mkdir -p /out /src \
  && test "${DX_RCLONE_BUILD_VERSION}" = "v1.75.0" \
  && test "${DX_RCLONE_X_IMAGE_VERSION}" = "v0.45.0" \
  && test "$(go env GOVERSION)" = "go${DX_RCLONE_GO_BUILD_VERSION}"
# rclone v1.75.0 still resolves golang.org/x/image v0.44.0, which is affected by
# CVE-2026-46603. Build the exact tagged rclone source but raise only x/image to
# the fixed v0.45.0 release before compiling. This keeps the rclone release pinned
# while preventing the vulnerable image decoder from being embedded in the binary.
RUN set -eux; \
  retry_go() { \
    attempt=1; \
    while ! "$@"; do \
      if [ "$attempt" -ge 5 ]; then return 1; fi; \
      sleep "$((attempt * 4))"; \
      attempt="$((attempt + 1))"; \
    done; \
  }; \
  retry_go go mod download "github.com/rclone/rclone@${DX_RCLONE_BUILD_VERSION}"; \
  rclone_src="$(go env GOMODCACHE)/github.com/rclone/rclone@${DX_RCLONE_BUILD_VERSION}"; \
  test -f "${rclone_src}/go.mod"; \
  cp -a "${rclone_src}" /src/rclone; \
  chmod -R u+w /src/rclone

WORKDIR /src/rclone

# Let the Go module resolver perform the security upgrade so transitive
# requirements (notably x/text v0.41.0 required by x/image v0.45.0) remain
# internally consistent. Editing only the x/image require line can leave the
# copied release module in a graph that needs further go.mod updates at build time.
# GitHub-hosted Docker builds occasionally see transient HTTP/2 stream resets from
# proxy.golang.org/sum.golang.org. Keep checksum verification enabled, force the
# simpler HTTP/1.1 transport, and retry only network operations. A bad checksum
# still fails closed at go get/go mod download/go mod verify.
RUN set -eux; \
  retry_go() { \
    attempt=1; \
    while ! "$@"; do \
      if [ "$attempt" -ge 5 ]; then return 1; fi; \
      sleep "$((attempt * 4))"; \
      attempt="$((attempt + 1))"; \
    done; \
  }; \
  retry_go go get "golang.org/x/image@${DX_RCLONE_X_IMAGE_VERSION}"; \
  test "$(go list -m -f '{{.Version}}' golang.org/x/image)" = "${DX_RCLONE_X_IMAGE_VERSION}"; \
  retry_go go mod download all; \
  go mod verify

RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -X github.com/rclone/rclone/fs.Version=${DX_RCLONE_BUILD_VERSION}" \
      -o /out/rclone . \
  && test -x /out/rclone
RUN go version /out/rclone | tee /out/rclone-go-version.txt \
  && grep -F " go${DX_RCLONE_GO_BUILD_VERSION}" /out/rclone-go-version.txt >/dev/null \
  && go version -m /out/rclone > /out/rclone-buildinfo.txt \
  && grep -F "$(printf '\tdep\tgolang.org/x/image\t%s' "${DX_RCLONE_X_IMAGE_VERSION}")" /out/rclone-buildinfo.txt >/dev/null \
  && env -u RCLONE_VERSION -u RCLONE_GO_VERSION /out/rclone version > /out/rclone-version.txt \
  && printf 'rclone=%s\ngo=%s\nx-image=%s\n' "${DX_RCLONE_BUILD_VERSION}" "go${DX_RCLONE_GO_BUILD_VERSION}" "${DX_RCLONE_X_IMAGE_VERSION}" > /out/rclone-build-manifest.txt \
  && test -s /out/rclone-buildinfo.txt \
  && test -s /out/rclone-version.txt \
  && test -s /out/rclone-build-manifest.txt

# Tesseract 5.5.3 contains the upstream fixes for the July/August 2026
# traineddata memory-safety advisories. Debian 13 currently ships 5.5.0, so
# build the signed-release commit directly and copy only the production OCR
# executable into the final image. Training, graphics, libarchive and libcurl
# support are intentionally disabled because Direct-Xfer does not use them.
FROM node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284 AS tesseract-builder
ARG DX_TESSERACT_BUILD_VERSION
ARG DX_TESSERACT_BUILD_COMMIT
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    cmake \
    g++ \
    git \
    libleptonica-dev \
    ninja-build \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /out /src/tesseract \
  && git -C /src/tesseract init \
  && git -C /src/tesseract remote add origin https://github.com/tesseract-ocr/tesseract.git \
  && git -C /src/tesseract fetch --depth=1 origin \
       "refs/tags/${DX_TESSERACT_BUILD_VERSION}:refs/tags/${DX_TESSERACT_BUILD_VERSION}" \
  && test "$(git -C /src/tesseract cat-file -t refs/tags/${DX_TESSERACT_BUILD_VERSION})" = "tag" \
  && test "$(git -C /src/tesseract rev-parse refs/tags/${DX_TESSERACT_BUILD_VERSION}^{commit})" = "${DX_TESSERACT_BUILD_COMMIT}" \
  && git -C /src/tesseract checkout --detach "refs/tags/${DX_TESSERACT_BUILD_VERSION}^{commit}" \
  && test "$(git -C /src/tesseract rev-parse HEAD)" = "${DX_TESSERACT_BUILD_COMMIT}" \
  && test "$(cat /src/tesseract/VERSION)" = "${DX_TESSERACT_BUILD_VERSION}"
WORKDIR /src/tesseract
RUN cmake -S /src/tesseract -B /src/tesseract/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_TRAINING_TOOLS=OFF \
      -DBUILD_TESTS=OFF \
      -DGRAPHICS_DISABLED=ON \
      -DDISABLE_ARCHIVE=ON \
      -DDISABLE_CURL=ON \
      -DOPENMP_BUILD=OFF \
      -DENABLE_NATIVE=OFF \
      -DENABLE_CCACHE=OFF \
      -DENABLE_PRECOMPILED_HEADERS=OFF \
  && cmake --build /src/tesseract/build --target tesseract --parallel "$(nproc)" \
  && cp /src/tesseract/build/bin/tesseract /out/tesseract \
  && strip /out/tesseract \
  && /out/tesseract --version | head -n 1 | grep -Fx "tesseract ${DX_TESSERACT_BUILD_VERSION}" \
  && cp /src/tesseract/LICENSE /out/tesseract-LICENSE \
  && printf 'tesseract=%s\ncommit=%s\nshared=off\ntraining=off\ngraphics=off\narchive=off\ncurl=off\n' \
       "${DX_TESSERACT_BUILD_VERSION}" "${DX_TESSERACT_BUILD_COMMIT}" \
       > /out/tesseract-build-manifest.txt

FROM node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284 AS dependencies

WORKDIR /app

# Production dependencies (cached layer). The lockfile is copied too so installs
# are reproducible across dev / CI / production.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284
ARG DX_RCLONE_BUILD_VERSION
ARG DX_RCLONE_GO_BUILD_VERSION
ARG DX_RCLONE_X_IMAGE_VERSION
ARG DX_TESSERACT_BUILD_VERSION
ARG DX_TESSERACT_BUILD_COMMIT

WORKDIR /app

COPY --from=rclone-builder /out/rclone /usr/local/bin/rclone
COPY third_party/rclone/COPYING /usr/share/doc/direct-xfer/rclone-COPYING
COPY --from=rclone-builder /out/rclone-buildinfo.txt /usr/share/doc/direct-xfer/rclone-buildinfo.txt
COPY --from=rclone-builder /out/rclone-build-manifest.txt /usr/share/doc/direct-xfer/rclone-build-manifest.txt
COPY --from=tesseract-builder /out/tesseract /usr/local/bin/tesseract
COPY --from=tesseract-builder /out/tesseract-LICENSE /usr/share/doc/direct-xfer/tesseract-LICENSE
COPY --from=tesseract-builder /out/tesseract-build-manifest.txt /usr/share/doc/direct-xfer/tesseract-build-manifest.txt

# Pull all Debian security updates before installing the OCR/PDF runtime.
# Tesseract itself is NOT installed from Debian: the final image receives the
# pinned 5.5.3 executable from tesseract-builder above. Only distro language
# data and the minimal Leptonica runtime are installed here. This avoids the
# large Cairo/Pango/ICU/curl/archive dependency set that Debian's tesseract-ocr
# binary would otherwise add. Poppler remains for pdftotext/pdftoppm only.
# npm/corepack are build tools, not runtime dependencies; removing them from the
# final image drops their global dependency tree and its avoidable CVE surface.
# Keep setup and verification in separate layers so a failed invariant is named
# explicitly in CI rather than being hidden in one very large shell command.
RUN set -eux; \
  apt-get update; \
  DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y; \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    libleptonica6 \
    poppler-utils \
    tesseract-ocr-eng \
    tesseract-ocr-fra \
    tesseract-ocr-osd \
    tesseract-ocr-spa \
    util-linux; \
  update-ca-certificates; \
  test -s /etc/ssl/certs/ca-certificates.crt

# The distro language packs only recommend Debian's tesseract binary; they must
# never pull it into this image. The actual OCR engine above is the pinned 5.5.3
# build. Resolve the tessdata directory from the installed package instead of
# relying on a distro path convention, and verify all requested languages exist.
RUN set -eux; \
  test "$(dpkg-query -W -f='${db:Status-Status}' tesseract-ocr 2>/dev/null || true)" != "installed"; \
  test "$(dpkg-query -W -f='${db:Status-Status}' libtesseract5 2>/dev/null || true)" != "installed"; \
  giflib_version="$(dpkg-query -W -f='${Version}' libgif7)"; \
  dpkg --compare-versions "$giflib_version" ge '5.2.2-1+deb13u1'; \
  mkdir -p /usr/share/doc/direct-xfer; \
  dpkg-query -W -f='${Package}\t${Version}\n' \
    ca-certificates libgif7 libleptonica6 libnss3 poppler-utils util-linux \
    > /usr/share/doc/direct-xfer/os-packages.tsv; \
  tessdata_eng="$(dpkg-query -L tesseract-ocr-eng | awk '/\/eng[.]traineddata$/{print; exit}')"; \
  test -n "$tessdata_eng"; \
  tessdata_dir="$(dirname "$tessdata_eng")"; \
  test -d "$tessdata_dir"; \
  for lang in eng fra osd spa; do test -s "$tessdata_dir/$lang.traineddata"; done; \
  printf '%s\n' "$tessdata_dir" > /usr/share/doc/direct-xfer/tessdata-dir.txt; \
  test "$tessdata_dir" = /usr/share/tesseract-ocr/5/tessdata

# TESSDATA_PREFIX must point to the directory that directly contains the
# traineddata files. Debian installs those files in /usr/share/tesseract-ocr/5/tessdata;
# using its parent makes the custom Tesseract 5.5.3 binary report no languages.
RUN set -eux; \
  rm -f /usr/bin/pdfattach /usr/bin/pdfdetach /usr/bin/pdffonts /usr/bin/pdfimages \
    /usr/bin/pdfinfo /usr/bin/pdfseparate /usr/bin/pdfsig /usr/bin/pdftocairo /usr/bin/pdfunite \
    /usr/bin/text2image; \
  for unused in pdfattach pdfdetach pdffonts pdfimages pdfinfo pdfseparate pdfsig pdftocairo pdfunite text2image; do test ! -e "/usr/bin/$unused"; done; \
  TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata tesseract --version | head -n 1 | grep -Fx "tesseract ${DX_TESSERACT_BUILD_VERSION}"; \
  for lang in eng fra osd spa; do TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata tesseract --list-langs 2>/dev/null | grep -Fx "$lang" >/dev/null; done; \
  pdftotext -v >/dev/null 2>&1; \
  pdftoppm -v >/dev/null 2>&1; \
  setpriv --version >/dev/null; \
  env -u RCLONE_VERSION -u RCLONE_GO_VERSION rclone version > /usr/share/doc/direct-xfer/rclone-version.txt; \
  test -s /usr/share/doc/direct-xfer/rclone-version.txt; \
  grep -Fx "rclone=${DX_RCLONE_BUILD_VERSION}" /usr/share/doc/direct-xfer/rclone-build-manifest.txt >/dev/null; \
  grep -Fx "go=go${DX_RCLONE_GO_BUILD_VERSION}" /usr/share/doc/direct-xfer/rclone-build-manifest.txt >/dev/null; \
  grep -Fx "x-image=${DX_RCLONE_X_IMAGE_VERSION}" /usr/share/doc/direct-xfer/rclone-build-manifest.txt >/dev/null; \
  grep -Fx "tesseract=${DX_TESSERACT_BUILD_VERSION}" /usr/share/doc/direct-xfer/tesseract-build-manifest.txt >/dev/null; \
  grep -Fx "commit=${DX_TESSERACT_BUILD_COMMIT}" /usr/share/doc/direct-xfer/tesseract-build-manifest.txt >/dev/null; \
  test -s /usr/share/doc/direct-xfer/rclone-COPYING; \
  test -s /usr/share/doc/direct-xfer/rclone-buildinfo.txt; \
  test -s /usr/share/doc/direct-xfer/tesseract-LICENSE

RUN set -eux; \
  rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack; \
  rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/yarn; \
  apt-get clean; \
  rm -rf /var/lib/apt/lists/*

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
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata \
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
  'validate_id() {' \
  '  label="$1"' \
  '  value="$2"' \
  '  case "$value" in' \
  '    ""|0|0*|*[!0-9]*)' \
  '      echo "ERROR: $label must be a canonical decimal id between 1 and 4294967294." >&2' \
  '      exit 1' \
  '      ;;' \
  '  esac' \
  '  if [ "${#value}" -gt 10 ] || { [ "${#value}" -eq 10 ] && [ "$value" -gt 4294967294 ]; }; then' \
  '    echo "ERROR: $label must be a canonical decimal id between 1 and 4294967294." >&2' \
  '    exit 1' \
  '  fi' \
  '}' \
  'validate_id PUID "$PUID"' \
  'validate_id PGID "$PGID"' \
  'if [ "$(id -u)" = "0" ]; then' \
  '  mkdir -p -- "$DATA_DIR" "$IMAGES_DIR" "$INBOX_DIR" 2>/dev/null || true' \
  '  chown -R -- "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true' \
  '  chown -R -- "$PUID:$PGID" "$IMAGES_DIR" 2>/dev/null || true' \
  '  chown -- "$PUID:$PGID" "$INBOX_DIR" 2>/dev/null || true' \
  '  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --no-new-privs --bounding-set=-all -- "$@"' \
  'fi' \
  'exec "$@"' \
  > /usr/local/bin/docker-entrypoint.sh \
  && chmod 0755 /usr/local/bin/docker-entrypoint.sh

# Probes the public /healthz liveness endpoint (always 200 when the server is
# healthy) and requires a real 200 — so an internal error / misroute fails the check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||55750)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# NOTE for scanners: no static `USER` here on purpose. The container must start
# as root ONLY to chown the bind-mounted /data, /Images and /Direct-Xfer volumes (see the
# entrypoint script above), then immediately re-execs the actual process as the
# unprivileged runtime UID/GID via setpriv. IDs are validated before any root-owned
# filesystem operation, supplementary groups/capabilities are cleared, and no-new-privs
# is set before `node server.js` starts — a static USER directive would break the chown step on
# fresh/host-owned bind mounts. Verified at runtime: `docker exec <container> id`
# reports uid=1000(node).
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["node", "server.js"]
