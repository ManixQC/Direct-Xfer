'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('public Cloudflare broker implements the Direct-Xfer broker API without localhost callbacks', () => {
  const src = read('oauth-broker/cloudflare-worker/src/index.js');
  for (const route of ['/healthz','/v1/info','/v1/google/sessions','/v1/google/callback','/v1/google/token']) {
    assert.ok(src.includes(route), `missing broker route: ${route}`);
  }
  assert.match(src, /runtime:'cloudflare-workers'/);
  assert.match(src, /callbackUrl:`\$\{origin\}\/v1\/google\/callback`/);
  assert.doesNotMatch(src, /127\.0\.0\.1:53682|localhost:53682/);
  assert.match(src, /AES-GCM/);
  assert.match(src, /env\.DB\.prepare/);
});

test('public broker deployment requires secrets instead of embedding Google credentials', () => {
  const config = read('oauth-broker/cloudflare-worker/wrangler.jsonc.example');
  const source = read('oauth-broker/cloudflare-worker/src/index.js');
  assert.match(config, /GOOGLE_CLIENT_ID/);
  assert.match(config, /GOOGLE_CLIENT_SECRET/);
  assert.match(config, /BROKER_DATA_KEY/);
  assert.doesNotMatch(source, /AIza[0-9A-Za-z_-]{20,}|GOCSPX-/);
  assert.match(read('oauth-broker/cloudflare-worker/.gitignore'), /\.dev\.vars/);
});

test('PowerShell deployment provisions D1, migrations, secrets, and a public Worker', () => {
  const ps = read('oauth-broker/cloudflare-worker/scripts/deploy.ps1');
  assert.match(ps, /wrangler d1 list --json/);
  assert.match(ps, /wrangler d1 create/);
  assert.match(ps, /wrangler d1 migrations apply/);
  assert.match(ps, /wrangler deploy --secrets-file/);
  assert.match(ps, /workers\\\.dev/);
  assert.match(ps, /DIRECT_XFER_OAUTH_BROKER_URL/);
});
