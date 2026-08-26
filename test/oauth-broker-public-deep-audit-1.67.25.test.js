'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { GoogleOAuthBrokerClient, cleanBrokerUrl } = require('../lib/google-oauth-broker-client');

test('1.67.26 broker URL validation rejects path prefixes that public broker routes cannot serve', () => {
  assert.equal(cleanBrokerUrl('https://oauth.example.test/'), 'https://oauth.example.test');
  assert.throws(() => cleanBrokerUrl('https://oauth.example.test/broker'), /oauth-broker-url-invalid/);
  assert.throws(() => cleanBrokerUrl('https://user:pass@oauth.example.test'), /oauth-broker-url-invalid/);
});

test('1.67.26 broker client rejects redirected, oversized, or structurally altered broker responses', async () => {
  const client = new GoogleOAuthBrokerClient({
    baseUrl:'https://oauth.example.test',
    fetch:async (url, options) => {
      assert.equal(options.redirect, 'error');
      if (String(url).endsWith('/v1/info')) {
        return new Response(JSON.stringify({
          service:'direct-xfer-oauth-broker', google:true, storage:true,
          callbackUrl:'https://oauth.example.test/v1/google/callback', version:'2',
        }), { status:200, headers:{'content-type':'application/json'} });
      }
      throw new Error('unexpected');
    },
  });
  assert.equal((await client.info()).available, true);

  const altered = new GoogleOAuthBrokerClient({
    baseUrl:'https://oauth.example.test',
    fetch:async () => new Response(JSON.stringify({
      service:'direct-xfer-oauth-broker', google:true, storage:true,
      callbackUrl:'https://evil.example/v1/google/callback', version:'2',
    }), { status:200 }),
  });
  assert.equal((await altered.info()).available, false);
});

test('1.67.26 Cloudflare callback is single-claim and credential/session commit is transactional', () => {
  const src = read('oauth-broker/cloudflare-worker/src/index.js');
  assert.match(src, /UPDATE sessions SET status='exchanging'.*WHERE id=\? AND status='waiting'/s);
  assert.match(src, /const results = await env\.DB\.batch\(\[/);
  assert.match(src, /WHERE EXISTS \(SELECT 1 FROM sessions WHERE id=\? AND status='exchanging'\)/);
  assert.match(src, /UPDATE sessions SET status='completed'.*status='exchanging'/s);
  assert.match(src, /broker-storage-not-ready/);
  assert.match(src, /async function storageReady/);
});

test('1.67.26 Cloudflare token endpoint limits request bodies and invalidates dead Google grants', () => {
  const src = read('oauth-broker/cloudflare-worker/src/index.js');
  assert.match(src, /async function readTextLimited/);
  assert.match(src, /async function parseForm\(request, max = 16 \* 1024\)/);
  assert.match(src, /DELETE FROM credentials WHERE id=\?/);
  assert.match(src, /code === 'invalid_grant'[\s\S]*return json\(\{ error:'invalid_grant' \}, 400\)/);
  assert.match(src, /UPDATE credentials SET last_used_at=\?, expires_at=\?/);
  assert.match(src, /DELETE FROM rate_limits WHERE window_start < \?/);
});

test('1.67.26 redeploy scripts preserve the broker data key and clean temporary secret files', () => {
  const sh = read('oauth-broker/cloudflare-worker/scripts/deploy.sh');
  const ps = read('oauth-broker/cloudflare-worker/scripts/deploy.ps1');
  for (const src of [sh, ps]) {
    assert.match(src, /secret list --format json/);
    assert.match(src, /BROKER_DATA_KEY existante|BROKER_DATA_KEY/);
  }
  assert.match(sh, /rm -f "\$file"[\s\S]*return "\$status"/);
  assert.match(sh, /wrangler deployments list --json/);
  assert.match(sh, /SELECT COUNT\(\*\) AS count FROM credentials/);
  assert.match(sh, /DX_OAUTH_BROKER_FORCE_GOOGLE_CREDENTIAL_REPLACE/);
  assert.match(sh, /Arrêt pour éviter toute rotation accidentelle de BROKER_DATA_KEY/);
  assert.doesNotMatch(sh, /--location\s+enam/);
  assert.match(ps, /wrangler deployments list --json/);
  assert.match(ps, /SELECT COUNT\(\*\) AS count FROM credentials/);
  assert.match(ps, /DX_OAUTH_BROKER_FORCE_GOOGLE_CREDENTIAL_REPLACE/);
  assert.match(ps, /Write-Utf8NoBom/);
  assert.match(ps, /UTF8Encoding\(\$false\)/);
  assert.match(ps, /RandomNumberGenerator\]::Create\(\)/);
  assert.match(ps, /\.GetBytes\(\$brokerKeyBytes\)/);
  assert.doesNotMatch(ps, /RandomNumberGenerator\]::Fill/);
  assert.doesNotMatch(ps, /\?\?/);
  assert.match(ps, /finally \{ Remove-Item \$secretFile/);
});


test('1.67.26 public broker pins a Wrangler baseline that supports required-secret validation', () => {
  const pkg = JSON.parse(read('oauth-broker/cloudflare-worker/package.json'));
  assert.equal(pkg.version, '1.71.15');
  assert.match(String(pkg.devDependencies && pkg.devDependencies.wrangler || ''), /^\^4\.94\.0$/);
});

test('1.67.26 node broker cleans rate buckets and extends active credential lifetime', () => {
  const src = read('oauth-broker/server.js');
  assert.match(src, /for \(const \[id, entry\] of rateBuckets\)/);
  assert.match(src, /credential\.expiresAt=now \+ CREDENTIAL_TTL_MS/);
  assert.match(src, /delete store\.credentials\[clientId\]/);
  assert.match(src, /invalid_grant/);
});

test('1.67.26 Direct-Xfer broker polling finalization is single-flight', () => {
  const src = read('lib/server/storage-connector-config.js');
  assert.match(src, /item\.finalizePromise/);
  assert.match(src, /if \(item\.finalizePromise\)/);
  assert.match(src, /item\.finalizePromise = \(async \(\) =>/);
  assert.match(src, /await item\.finalizePromise/);
});
