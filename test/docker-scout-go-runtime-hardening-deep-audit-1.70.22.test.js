'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function canRunPosixEntrypoint(platform = process.platform, getuid = process.getuid) {
  return platform !== 'win32' && typeof getuid === 'function';
}

const CAN_RUN_POSIX_ENTRYPOINT = canRunPosixEntrypoint();

const ROOT = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').replace(/\r\n?/g, '\n');

function extractEntrypoint(source = dockerfile) {
  const normalized = String(source).replace(/\r\n?/g, '\n');
  const start = normalized.indexOf("RUN printf '%s\\n'");
  const end = normalized.indexOf('\n\n# Probes the public /healthz', start);
  assert.notEqual(start, -1, 'entrypoint generator must exist');
  assert.notEqual(end, -1, 'entrypoint generator must have a stable end marker');
  const block = normalized.slice(start, end);
  const lines = [];
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^\s*'(.*)' \\$/);
    if (match) lines.push(match[1]);
  }
  assert.equal(lines[0], '#!/bin/sh');
  assert.equal(lines.at(-1), 'exec "$@"');
  return lines.join('\n') + '\n';
}

function runEntrypoint({ puid='99', pgid='100', code='process.stdout.write(String(process.getuid?.() ?? -1))' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-entrypoint-audit-'));
  const script = path.join(tmp, 'entrypoint.sh');
  const data = path.join(tmp, 'data');
  const images = path.join(tmp, 'images');
  const inbox = path.join(tmp, 'inbox');
  fs.writeFileSync(script, extractEntrypoint(), { mode:0o755 });
  try {
    return spawnSync(script, [process.execPath, '-e', code], {
      encoding:'utf8',
      env:{ ...process.env, PUID:puid, PGID:pgid, DATA_DIR:data, IMAGES_DIR:images, INBOX_DIR:inbox },
      timeout:10000,
    });
  } finally {
    fs.rmSync(tmp, { recursive:true, force:true });
  }
}


test('1.70.22 never tries to execute the POSIX entrypoint in Windows CI', () => {
  assert.equal(canRunPosixEntrypoint('win32', undefined), false);
  assert.equal(canRunPosixEntrypoint('win32', () => 0), false);
  assert.equal(canRunPosixEntrypoint('linux', () => 0), true);
});

test('1.70.22 entrypoint extraction is stable with Windows CRLF checkouts', () => {
  const crlfDockerfile = dockerfile.replace(/\n/g, '\r\n');
  const entrypoint = extractEntrypoint(crlfDockerfile);
  assert.match(entrypoint, /^#!\/bin\/sh\n/);
  assert.match(entrypoint, /exec "\$@"\n$/);
});



test('1.70.22 keeps the PUID/PGID fail-closed guards visible to Windows/static CI', () => {
  const entrypoint = extractEntrypoint();
  assert.match(entrypoint, /\$label must be a canonical decimal id between 1 and 4294967294/);
  assert.match(entrypoint, /validate_id PUID "\$PUID"/);
  assert.match(entrypoint, /validate_id PGID "\$PGID"/);
  assert.match(entrypoint, /case "\$value" in/);
  assert.match(entrypoint, /""\|0\|0\*\|\*\[!0-9\]\*/);
  assert.match(entrypoint, /--reuid="\$PUID"/);
  assert.match(entrypoint, /--regid="\$PGID"/);
});
test('1.70.22 rejects uid/gid spellings that setpriv can otherwise wrap or reinterpret as root', { skip: !CAN_RUN_POSIX_ENTRYPOINT }, () => {
  const dangerous = ['0', '00', '000000', '+0', '-0', '-1', '4294967295', '4294967296', '99999999999', 'root', '99:100'];
  for (const value of dangerous) {
    const result = runEntrypoint({ puid:value, pgid:'100' });
    assert.notEqual(result.status, 0, `dangerous PUID ${JSON.stringify(value)} must fail closed`);
    assert.match(result.stderr, /PUID must be a canonical decimal id between 1 and 4294967294/);
  }
  for (const value of dangerous) {
    const result = runEntrypoint({ puid:'99', pgid:value });
    assert.notEqual(result.status, 0, `dangerous PGID ${JSON.stringify(value)} must fail closed`);
    assert.match(result.stderr, /PGID must be a canonical decimal id between 1 and 4294967294/);
  }
});

test('1.70.22 accepts normal PUID/PGID values and actually drops root when the test runner is root', { skip: !CAN_RUN_POSIX_ENTRYPOINT }, () => {
  const result = runEntrypoint();
  assert.equal(result.status, 0, result.stderr);
  const expected = typeof process.getuid === 'function' && process.getuid() === 0 ? '99' : String(process.getuid?.() ?? -1);
  assert.equal(result.stdout, expected);
});

test('1.70.22 enables no-new-privs and removes the capability bounding set before Node starts', { skip: !CAN_RUN_POSIX_ENTRYPOINT || process.getuid() !== 0 }, () => {
  const code = `const fs=require('fs');const s=fs.readFileSync('/proc/self/status','utf8');for(const k of ['NoNewPrivs','CapEff','CapBnd']){const m=s.match(new RegExp('^'+k+':\\\\s*(.+)$','m'));process.stdout.write(k+'='+m[1].trim()+'\\n')}`;
  const result = runEntrypoint({ code });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^NoNewPrivs=1$/m);
  assert.match(result.stdout, /^CapEff=0+$/m);
  assert.match(result.stdout, /^CapBnd=0+$/m);
});

test('1.70.22 treats rclone source, toolchain, module metadata and licence as one verified build unit', () => {
  assert.match(dockerfile, /ARG DX_RCLONE_BUILD_VERSION=v1\.75\.0/);
  assert.match(dockerfile, /ARG DX_RCLONE_GO_BUILD_VERSION=1\.25\.14/);
  assert.match(dockerfile, /ARG DX_RCLONE_X_IMAGE_VERSION=v0\.45\.0/);
  assert.match(dockerfile, /@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437/);
  assert.match(dockerfile, /ENV GOTOOLCHAIN=local \\\n    GOSUMDB=sum\.golang\.org/);
  assert.match(dockerfile, /test "\$\{DX_RCLONE_BUILD_VERSION\}" = "v1\.75\.0"/);
  assert.match(dockerfile, /test "\$\{DX_RCLONE_X_IMAGE_VERSION\}" = "v0\.45\.0"/);
  assert.match(dockerfile, /go get "golang\.org\/x\/image@\$\{DX_RCLONE_X_IMAGE_VERSION\}"/);
  assert.doesNotMatch(dockerfile, /go mod edit -require=.*golang\.org\/x\/image/);
  assert.match(dockerfile, /go list -m -f '\{\{\.Version\}\}' golang\.org\/x\/image/);
  assert.match(dockerfile, /go version \/out\/rclone \| tee \/out\/rclone-go-version\.txt/);
  assert.match(dockerfile, /go version -m \/out\/rclone > \/out\/rclone-buildinfo\.txt/);
  assert.match(dockerfile, /env -u RCLONE_VERSION -u RCLONE_GO_VERSION \/out\/rclone version > \/out\/rclone-version\.txt/);
  assert.match(dockerfile, /env -u RCLONE_VERSION -u RCLONE_GO_VERSION rclone version > \/usr\/share\/doc\/direct-xfer\/rclone-version\.txt/);
  assert.doesNotMatch(dockerfile, /^ARG RCLONE_VERSION(?:=|$)/m);
  assert.doesNotMatch(dockerfile, /^ARG RCLONE_GO_VERSION(?:=|$)/m);
  assert.match(dockerfile, /printf 'rclone=%s\\ngo=%s\\nx-image=%s\\n'/);
  assert.match(dockerfile, /COPY third_party\/rclone\/COPYING \/usr\/share\/doc\/direct-xfer\/rclone-COPYING/);
  assert.match(dockerfile, /COPY --from=rclone-builder \/out\/rclone-buildinfo\.txt \/usr\/share\/doc\/direct-xfer\/rclone-buildinfo\.txt/);
  assert.match(dockerfile, /COPY --from=rclone-builder \/out\/rclone-build-manifest\.txt \/usr\/share\/doc\/direct-xfer\/rclone-build-manifest\.txt/);
  assert.doesNotMatch(dockerfile, /rclone-version\.txt.*go\/version:/);
});

test('1.70.22 keeps build-arg verification coherent across builder and final stages', () => {
  const finalStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-trixie-slim'));
  assert.match(finalStage, /^FROM node:22-trixie-slim\nARG DX_RCLONE_BUILD_VERSION\nARG DX_RCLONE_GO_BUILD_VERSION\nARG DX_RCLONE_X_IMAGE_VERSION/m);
  assert.match(finalStage, /rclone=\$\{DX_RCLONE_BUILD_VERSION\}/);
  assert.match(finalStage, /go=go\$\{DX_RCLONE_GO_BUILD_VERSION\}/);
  assert.match(finalStage, /x-image=\$\{DX_RCLONE_X_IMAGE_VERSION\}/);
  assert.doesNotMatch(finalStage, /rclone-version\.txt.*go\/version:/);
  assert.doesNotMatch(finalStage, /grep -F "rclone v1\.75\.0"/);
});

test('1.70.22 places option terminators before all root-owned volume paths', () => {
  const entrypoint = extractEntrypoint();
  assert.match(entrypoint, /mkdir -p -- "\$DATA_DIR" "\$IMAGES_DIR" "\$INBOX_DIR"/);
  assert.match(entrypoint, /chown -R -- "\$PUID:\$PGID" "\$DATA_DIR"/);
  assert.match(entrypoint, /chown -R -- "\$PUID:\$PGID" "\$IMAGES_DIR"/);
  assert.match(entrypoint, /chown -- "\$PUID:\$PGID" "\$INBOX_DIR"/);
});
