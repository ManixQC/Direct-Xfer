'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

function runtimeAptInstallBlock() {
  const start = dockerfile.indexOf('apt-get install -y --no-install-recommends');
  assert.notEqual(start, -1, 'runtime apt install block must exist');
  const end = dockerfile.indexOf('&& update-ca-certificates', start);
  assert.notEqual(end, -1, 'runtime apt install block must terminate before CA refresh');
  return dockerfile.slice(start, end);
}

test('1.70.22 rebuilds rclone 1.75.0 with a patched pinned Go stdlib', () => {
  assert.match(dockerfile, /ARG DX_RCLONE_BUILD_VERSION=v1\.75\.0/);
  assert.match(dockerfile, /ARG DX_RCLONE_GO_BUILD_VERSION=1\.25\.14/);
  assert.match(dockerfile, /FROM golang:\$\{DX_RCLONE_GO_BUILD_VERSION\}-bookworm@sha256:[0-9a-f]{64} AS rclone-builder/);
  assert.match(dockerfile, /GOTOOLCHAIN=local/);
  assert.match(dockerfile, /test "\$\(go env GOVERSION\)" = "go\$\{DX_RCLONE_GO_BUILD_VERSION\}"/);
  assert.match(dockerfile, /CGO_ENABLED=0 GOBIN=\/out go install -trimpath/);
  assert.match(dockerfile, /github\.com\/rclone\/rclone@\$\{DX_RCLONE_BUILD_VERSION\}/);
  assert.match(dockerfile, /github\.com\/rclone\/rclone\/fs\.Version=\$\{DX_RCLONE_BUILD_VERSION\}/);
  assert.match(dockerfile, /go version \/out\/rclone \| tee \/out\/rclone-go-version\.txt/);
  assert.match(dockerfile, /go version -m \/out\/rclone > \/out\/rclone-buildinfo\.txt/);
  assert.match(dockerfile, /env -u RCLONE_VERSION -u RCLONE_GO_VERSION \/out\/rclone version > \/out\/rclone-version\.txt/);
  assert.doesNotMatch(dockerfile, /^ARG RCLONE_VERSION(?:=|$)/m);
  assert.doesNotMatch(dockerfile, /^ARG RCLONE_GO_VERSION(?:=|$)/m);
  assert.match(dockerfile, /COPY --from=rclone-builder \/out\/rclone \/usr\/local\/bin\/rclone/);
  assert.match(dockerfile, /grep -Fx "rclone=\$\{DX_RCLONE_BUILD_VERSION\}" \/usr\/share\/doc\/direct-xfer\/rclone-build-manifest\.txt/);
  assert.match(dockerfile, /grep -Fx "go=go\$\{DX_RCLONE_GO_BUILD_VERSION\}" \/usr\/share\/doc\/direct-xfer\/rclone-build-manifest\.txt/);
});

test('1.70.22 does not install Debian rclone or gosu in the final image', () => {
  const apt = runtimeAptInstallBlock();
  assert.doesNotMatch(apt, /(^|\s)rclone(\s|\\|$)/m);
  assert.doesNotMatch(apt, /(^|\s)gosu(\s|\\|$)/m);
  assert.match(apt, /(^|\s)util-linux(\s|\\|$)/m);
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
