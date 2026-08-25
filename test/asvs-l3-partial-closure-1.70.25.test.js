'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sanitizeImageMetadataFile } = require('../lib/photo-utils');
const { GoogleOAuthBrokerClient } = require('../lib/google-oauth-broker-client');
const { buildAsvsL3Report } = require('../lib/server/asvs-l3-policy');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function pngChunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.from(data);
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 4, 'ascii');
  body.copy(out, 8);
  // CRC is irrelevant to the lossless metadata parser; structural bounds are what
  // this regression exercises.
  out.writeUInt32BE(0, 8 + body.length);
  return out;
}

async function withTempFile(ext, data, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-asvs-meta-'));
  const file = path.join(dir, `sample.${ext}`);
  try {
    fs.writeFileSync(file, data);
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
  }
}

test('ASVS L3 repository-wide PARTIAL closure audit passes with no blocking finding', () => {
  const run = spawnSync(process.execPath, ['scripts/asvs-l3-partial-audit.js', '--write'], { cwd:ROOT, encoding:'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(read('security/asvs-l3-partial-audit.json'));
  assert.equal(report.passed, true);
  assert.equal(report.findings.length, 0);
  assert.equal(report.controls.length, 38);
  assert.ok(report.filesScanned >= 120);
  for (const control of report.controls) assert.equal(control.ok, true, control.id);
});

test('ASVS V14.2.8 strips JPEG EXIF metadata by default', async () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff,0xd8]),
    Buffer.from([0xff,0xe1,0x00,0x06]), Buffer.from('Exif'),
    Buffer.from([0xff,0xda,0x00,0x02,0xff,0xd9]),
  ]);
  await withTempFile('jpg', jpeg, async (file) => {
    const result = await sanitizeImageMetadataFile(file, 'jpg');
    assert.equal(result.supported, true);
    assert.equal(result.changed, true);
    assert.doesNotMatch(fs.readFileSync(file).toString('latin1'), /Exif/);
  });
});

test('ASVS V14.2.8 strips PNG textual/EXIF metadata by default', async () => {
  const png = Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    pngChunk('tEXt', Buffer.from('GPS=secret')),
    pngChunk('eXIf', Buffer.from('private')),
    pngChunk('IEND'),
  ]);
  await withTempFile('png', png, async (file) => {
    const result = await sanitizeImageMetadataFile(file, 'png');
    assert.equal(result.supported, true);
    assert.equal(result.changed, true);
    const out = fs.readFileSync(file).toString('latin1');
    assert.doesNotMatch(out, /GPS=secret|private|tEXt|eXIf/);
    assert.match(out, /IEND/);
  });
});

test('ASVS V14.2.8 strips WebP EXIF/XMP and GIF comment metadata', async () => {
  const webp = Buffer.alloc(24);
  webp.write('RIFF', 0, 'ascii'); webp.writeUInt32LE(16, 4); webp.write('WEBP', 8, 'ascii');
  webp.write('EXIF', 12, 'ascii'); webp.writeUInt32LE(4, 16); webp.write('gps!', 20, 'ascii');
  await withTempFile('webp', webp, async (file) => {
    const result = await sanitizeImageMetadataFile(file, 'webp');
    assert.equal(result.supported, true);
    assert.equal(result.changed, true);
    assert.doesNotMatch(fs.readFileSync(file).toString('latin1'), /EXIF|gps!/);
  });

  const gif = Buffer.concat([
    Buffer.from('GIF89a', 'ascii'), Buffer.from([1,0,1,0,0,0,0]),
    Buffer.from([0x21,0xfe,0x03]), Buffer.from('gps'), Buffer.from([0x00,0x3b]),
  ]);
  await withTempFile('gif', gif, async (file) => {
    const result = await sanitizeImageMetadataFile(file, 'gif');
    assert.equal(result.supported, true);
    assert.equal(result.changed, true);
    assert.doesNotMatch(fs.readFileSync(file).toString('latin1'), /gps/);
  });
});

test('ASVS V14.2.8 unsupported image metadata formats require explicit L3 retention consent at the route boundary', async () => {
  await withTempFile('avif', Buffer.from('not-parsed-here'), async (file) => {
    const result = await sanitizeImageMetadataFile(file, 'avif');
    assert.equal(result.supported, false);
  });
  for (const file of ['lib/server/admin-photo-routes.js', 'lib/server/pwa-routes.js']) {
    const source = read(file);
    assert.match(source, /image-metadata-consent-required/);
    assert.match(source, /metadataConsent/);
    assert.match(source, /sanitizeImageMetadataFile/);
  }
});

test('ASVS V10.1.2 broker OAuth is bound to the launching browser transaction', async () => {
  const baseUrl = 'https://broker.example';
  const id = 'session_12345678';
  const authUrl = `${baseUrl}/v1/google/authorize?session=${encodeURIComponent(id)}&binding=${'b'.repeat(32)}`;
  const fetch = async () => ({
    ok:true, status:200,
    headers:{ get:() => null },
    text:async () => JSON.stringify({ id, pollToken:'p'.repeat(32), authUrl, expiresAt:Date.now()+60_000 }),
  });
  const client = new GoogleOAuthBrokerClient({ baseUrl, fetch });
  const session = await client.createSession({ scope:'limited' });
  assert.equal(new URL(session.authUrl).origin, baseUrl);
  assert.equal(new URL(session.authUrl).pathname, '/v1/google/authorize');

  const bad = new GoogleOAuthBrokerClient({ baseUrl, fetch:async () => ({
    ok:true, status:200, headers:{ get:() => null },
    text:async () => JSON.stringify({ id, pollToken:'p'.repeat(32), authUrl:`https://evil.example/v1/google/authorize?session=${id}&binding=${'b'.repeat(32)}`, expiresAt:Date.now()+60_000 }),
  }) });
  await assert.rejects(() => bad.createSession({ scope:'limited' }), /oauth-broker-response-invalid/);

  for (const file of ['oauth-broker/server.js', 'oauth-broker/cloudflare-worker/src/index.js']) {
    const source = read(file);
    assert.match(source, /browserHash/);
    assert.match(source, /oauthBrowserCookieName/);
    assert.match(source, /SameSite=Lax/);
    assert.match(source, /timingSafe|safeEqual|safeEqualText/);
  }
});

test('OAuth worker source and embedded worker asset remain byte-identical', () => {
  assert.equal(read('lib/assets/oauth-broker-worker.mjs'), read('oauth-broker/cloudflare-worker/src/index.js'));
});

test('ASVS V2.3.3 share purge and PWA rating mutations have durable rollback semantics', () => {
  const share = read('lib/server/share-service.js');
  const pwa = read('lib/server/pwa-routes.js');
  assert.match(share, /purgePendingAt/);
  const purge = share.slice(share.indexOf('async function purgeTrashRecordById'), share.indexOf('async function purgeTrashRecordById') + 7000);
  assert.ok((purge.match(/persistNow\(\)/g) || []).length >= 2, 'purge must persist intent and final state');
  assert.ok(purge.indexOf('purgePendingAt') < purge.indexOf('destroyShareManagedData'), 'durable purge marker must precede destructive cleanup');
  assert.match(share, /restorePlainObject|Object\.assign/);
  const rate = pwa.slice(pwa.indexOf("/app/host/shares/:token/rate"), pwa.indexOf("/app/host/shares/:token/rate") + 5000);
  assert.match(rate, /const beforeFull = JSON\.parse\(JSON\.stringify\(share\)\)/);
  assert.match(rate, /if \(!persistNow\(\)\)/);
  assert.match(rate, /restorePlainObject\(share, beforeFull\)/);
});

test('ASVS V12.3.1 L3 transport policy requires HTTPS/TLS or local IPC and forbids ambiguous storage transports', () => {
  const policy = read('lib/server/asvs-l3-policy.js');
  const upload = read('lib/server/upload-reception-service.js');
  const storage = read('lib/server/storage-connector-config.js');
  const mail = read('lib/server/notification-service.js');
  assert.match(policy, /parsed\.protocol !== 'https:'/);
  assert.match(upload, /CLAMAV_SOCKET/);
  assert.match(upload, /CLAMAV_TLS/);
  assert.match(mail, /requireTLS:ASVS_L3_MODE === true/);
  assert.match(storage, /asvs-l3-encrypted-connector-required/);
  assert.match(storage, /type === 'smb' \|\| type === 'webdav'/);
});

test('ASVS L3 deployment-only controls are closed by signed requirement-specific evidence rather than operator booleans', () => {
  const policy = read('lib/server/asvs-l3-policy.js');
  const evidence = read('lib/server/asvs-l3-evidence.js');
  assert.match(policy, /deployment\.signed-evidence/);
  assert.doesNotMatch(policy, /deployment\.backend-authentication/);
  assert.match(evidence, /REQUIRED_DEPLOYMENT_REQUIREMENTS/);
  assert.match(evidence, /validObservation/);
  assert.match(evidence, /digest !== sha256Canonical\(row\.observation\)/);
});
test('ASVS V4/V16 strict HTTP boundary enforces media type and centralized security/error logging', () => {
  const http = read('lib/server/http-application.js');
  assert.match(http, /ASVS V4\.1\.1: guarantee a declared media type/);
  assert.match(http, /application\/octet-stream/);
  assert.match(http, /security-control-rejected/);
  assert.match(http, /security-control-failure/);
  assert.doesNotMatch(http, /detail:`\$\{method\} \$\{req\.originalUrl\}/);
});

test('ASVS V13.4.1/V15.2.3 deployment packaging is explicit and omits source-control/test trees', () => {
  const docker = read('Dockerfile');
  const windows = read('.github/workflows/build-windows-csharp.yml');
  assert.match(docker, /npm ci --omit=dev/);
  assert.match(docker, /COPY server\.js \.\//);
  assert.match(docker, /COPY lib \.\/lib/);
  assert.doesNotMatch(docker, /COPY\s+\.\s+\./);
  assert.doesNotMatch(docker, /COPY\s+test\b/);
  assert.match(windows, /Copy-Item @\('package\.json','package-lock\.json','server\.js'\)/);
  assert.match(windows, /prune-windows-node-modules\.ps1/);
});
