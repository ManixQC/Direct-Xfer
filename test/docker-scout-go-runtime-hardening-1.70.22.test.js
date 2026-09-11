'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

function runtimeAptInstallBlock() {
  const marker = '# Pull all Debian security updates before installing the OCR/PDF runtime.';
  const runtimeStart = dockerfile.indexOf(marker);
  assert.notEqual(runtimeStart, -1, 'runtime hardening stage must exist');
  const start = dockerfile.indexOf('apt-get install -y --no-install-recommends', runtimeStart);
  assert.notEqual(start, -1, 'runtime apt install block must exist');
  const end = dockerfile.indexOf('update-ca-certificates', start);
  assert.notEqual(end, -1, 'runtime apt install block must terminate before CA refresh');
  return dockerfile.slice(start, end);
}

test('1.71.49 rebuilds rclone 1.75.1 with patched Go/x-crypto security floors', () => {
  assert.match(dockerfile, /ARG DX_RCLONE_BUILD_VERSION=v1\.75\.1/);
  assert.match(dockerfile, /ARG DX_RCLONE_GO_BUILD_VERSION=1\.26\.6/);
  assert.match(dockerfile, /ARG DX_RCLONE_X_CRYPTO_VERSION=v0\.56\.0/);
  assert.match(dockerfile, /ARG DX_RCLONE_X_IMAGE_VERSION=v0\.45\.0/);
  assert.match(dockerfile, /ARG DX_RCLONE_GRPC_VERSION=v1\.85\.0-dev\.0\.20260825072537-93e31b48545e/);
  assert.match(dockerfile, /FROM golang:\$\{DX_RCLONE_GO_BUILD_VERSION\}-bookworm@sha256:[0-9a-f]{64} AS rclone-builder/);
  assert.match(dockerfile, /GOTOOLCHAIN=local/);
  assert.match(dockerfile, /test "\$\(go env GOVERSION\)" = "go\$\{DX_RCLONE_GO_BUILD_VERSION\}"/);
  assert.match(dockerfile, /go mod download "github\.com\/rclone\/rclone@\$\{DX_RCLONE_BUILD_VERSION\}"/);
  assert.match(dockerfile, /go list -m -f '\{\{\.Version\}\}' golang\.org\/x\/crypto/);
  assert.match(dockerfile, /go list -m -f '\{\{\.Version\}\}' golang\.org\/x\/image/);
  assert.match(dockerfile, /go get "google\.golang\.org\/grpc@\$\{DX_RCLONE_GRPC_VERSION\}"/);
  assert.match(dockerfile, /go list -m -f '\{\{\.Version\}\}' google\.golang\.org\/grpc/);
  assert.doesNotMatch(dockerfile, /go get "golang\.org\/x\/(?:crypto|image)@/);
  assert.doesNotMatch(dockerfile, /go mod edit -require=.*golang\.org\/x\/(?:crypto|image)/);
  assert.match(dockerfile, /CGO_ENABLED=0 go build -trimpath/);
  assert.match(dockerfile, /-o \/out\/rclone \./);
  assert.match(dockerfile, /github\.com\/rclone\/rclone\/fs\.Version=\$\{DX_RCLONE_BUILD_VERSION\}/);
  assert.match(dockerfile, /go version \/out\/rclone \| tee \/out\/rclone-go-version\.txt/);
  assert.match(dockerfile, /go version -m \/out\/rclone > \/out\/rclone-buildinfo\.txt/);
  assert.match(dockerfile, /golang\.org\/x\/crypto/);
  assert.match(dockerfile, /golang\.org\/x\/image/);
  assert.match(dockerfile, /x-crypto=\$\{DX_RCLONE_X_CRYPTO_VERSION\}/);
  assert.match(dockerfile, /x-image=\$\{DX_RCLONE_X_IMAGE_VERSION\}/);
  assert.match(dockerfile, /grpc=\$\{DX_RCLONE_GRPC_VERSION\}/);
  assert.match(dockerfile, /env -u RCLONE_VERSION -u RCLONE_GO_VERSION \/out\/rclone version > \/out\/rclone-version\.txt/);
  assert.doesNotMatch(dockerfile, /^ARG RCLONE_VERSION(?:=|$)/m);
  assert.doesNotMatch(dockerfile, /^ARG RCLONE_GO_VERSION(?:=|$)/m);
  assert.match(dockerfile, /COPY --from=rclone-builder \/out\/rclone \/usr\/local\/bin\/rclone/);
  assert.match(dockerfile, /grep -Fx "rclone=\$\{DX_RCLONE_BUILD_VERSION\}" \/usr\/share\/doc\/direct-xfer\/rclone-build-manifest\.txt/);
  assert.match(dockerfile, /grep -Fx "go=go\$\{DX_RCLONE_GO_BUILD_VERSION\}" \/usr\/share\/doc\/direct-xfer\/rclone-build-manifest\.txt/);
  assert.match(dockerfile, /grep -Fx "x-crypto=\$\{DX_RCLONE_X_CRYPTO_VERSION\}" \/usr\/share\/doc\/direct-xfer\/rclone-build-manifest\.txt/);
  assert.match(dockerfile, /grep -Fx "grpc=\$\{DX_RCLONE_GRPC_VERSION\}" \/usr\/share\/doc\/direct-xfer\/rclone-build-manifest\.txt/);
});

test('1.70.22 does not install Debian rclone or gosu in the final image', () => {
  const apt = runtimeAptInstallBlock();
  assert.doesNotMatch(apt, /(^|\s)rclone(\s|\\|;|$)/m);
  assert.doesNotMatch(apt, /(^|\s)gosu(\s|\\|;|$)/m);
  assert.match(apt, /(^|\s)util-linux(\s|\\|;|$)/m);
  assert.doesNotMatch(dockerfile, /exec gosu/);
});

test('1.70.22 drops root with setpriv while preserving PUID and PGID semantics', () => {
  assert.match(dockerfile, /setpriv --version/);
  assert.match(
    dockerfile,
    /exec setpriv --reuid="\$PUID" --regid="\$PGID" --clear-groups --no-new-privs --bounding-set=-all -- "\$@"/
  );
  assert.match(dockerfile, /PUID="\$\{PUID:-1000\}"/);
  assert.match(dockerfile, /PGID="\$\{PGID:-1000\}"/);
  assert.match(dockerfile, /validate_id PUID "\$PUID"/);
  assert.match(dockerfile, /validate_id PGID "\$PGID"/);
});
