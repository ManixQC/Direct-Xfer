'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOAuthBrokerDeploymentRoutes } = require('../lib/server/oauth-broker-deployment');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json' } });

function harness() {
  const routes = new Map();
  const audits = [];
  const adminRouter = {
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
  };
  createOAuthBrokerDeploymentRoutes({
    adminRouter,
    requireFullAdmin(_req, _res, next) { if (next) next(); },
    crypto,
    auditReq(_req, action, detail) { audits.push({ action, detail }); },
  });
  async function call(route, body) {
    let statusCode = 200;
    let payload;
    const req = { body, session:{ accountId:'owner-1' } };
    const res = { status(code) { statusCode = code; return this; }, json(value) { payload = value; return this; }, setHeader() {} };
    await routes.get(`POST ${route}`)(req, res);
    return { statusCode, payload };
  }
  return { call, audits };
}

test('1.67.27 installed UI offers broker deployment without source files or Wrangler', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const server = read('server.js');
  assert.match(html, /connector-config-google-broker-auto/);
  assert.match(html, /connector-config-google-cf-deploy/);
  assert.match(html, /connector-config-google-cf-finish/);
  assert.match(app, /deployGoogleBrokerAutomatically/);
  assert.match(app, /\/api\/storage\/oauth\/broker-auto\/prepare/);
  assert.match(app, /\/api\/storage\/oauth\/broker-auto\/google/);
  assert.match(server, /createOAuthBrokerDeploymentRoutes/);
  assert.match(read('Dockerfile'), /COPY lib \.\/lib/);
});

test('1.67.27 embedded Cloudflare assets stay byte-identical to the standalone broker', () => {
  assert.equal(read('lib/assets/oauth-broker-worker.mjs'), read('oauth-broker/cloudflare-worker/src/index.js'));
  assert.equal(read('lib/assets/oauth-broker-schema.sql'), read('oauth-broker/cloudflare-worker/migrations/0001_init.sql'));
});

test('1.67.27 automatic deployment uses Cloudflare APIs directly and never shells out to Wrangler', () => {
  const src = read('lib/server/oauth-broker-deployment.js');
  assert.match(src, /api\.cloudflare\.com\/client\/v4/);
  assert.match(src, /\/d1\/database/);
  assert.match(src, /\/workers\/scripts\//);
  assert.match(src, /\/subdomain/);
  assert.match(src, /secret_text/);
  assert.doesNotMatch(src, /child_process|execFile|spawn|wrangler|npm ci/);
});

test('1.67.27 Cloudflare token is kept server-side during the wizard and never returned to the browser', async () => {
  const accountId = 'a'.repeat(32);
  const databaseId = '11111111-2222-3333-4444-555555555555';
  const brokerUrl = 'https://direct-xfer-oauth-broker.example-subdomain.workers.dev';
  const apiToken = 'cf_test_token_abcdefghijklmnopqrstuvwxyz0123456789';
  let googleReady = false;
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url); requests.push({ u, method:options.method || 'GET', authorization:options.headers && options.headers.authorization });
    if (u === 'https://api.cloudflare.com/client/v4/accounts?per_page=50') return jsonResponse({ success:true, result:[{ id:accountId, name:'Test' }] });
    if (u.endsWith(`/accounts/${accountId}/workers/subdomain`)) return jsonResponse({ success:true, result:{ subdomain:'example-subdomain' } });
    if (u.includes(`/accounts/${accountId}/d1/database?name=`)) return jsonResponse({ success:true, result:[{ uuid:databaseId, name:'direct-xfer-oauth-broker' }] });
    if (u.endsWith(`/accounts/${accountId}/d1/database/${databaseId}/query`)) {
      const raw = options.body ? JSON.parse(options.body) : {};
      if (String(raw.sql || '').includes('COUNT(*) AS count')) return jsonResponse({ success:true, result:[{ results:[{ count:0 }], success:true }] });
      return jsonResponse({ success:true, result:[{ results:[], success:true }] });
    }
    if (u.endsWith(`/accounts/${accountId}/workers/scripts/direct-xfer-oauth-broker/secrets`) && (options.method || 'GET') === 'GET') return jsonResponse({ success:false, errors:[{ message:'not found' }] }, 404);
    if (u.endsWith(`/accounts/${accountId}/workers/scripts/direct-xfer-oauth-broker`) && options.method === 'PUT') {
      assert.ok(options.body instanceof FormData);
      return jsonResponse({ success:true, result:{ id:'direct-xfer-oauth-broker' } });
    }
    if (u.endsWith(`/accounts/${accountId}/workers/scripts/direct-xfer-oauth-broker/subdomain`) && options.method === 'POST') return jsonResponse({ success:true, result:{ enabled:true, previews_enabled:false } });
    if (u.endsWith(`/accounts/${accountId}/workers/scripts/direct-xfer-oauth-broker/secrets`) && options.method === 'PUT') {
      const secret = JSON.parse(options.body);
      assert.ok(['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'].includes(secret.name));
      if (secret.name === 'GOOGLE_CLIENT_SECRET') googleReady = true;
      return jsonResponse({ success:true, result:{ name:secret.name, type:'secret_text' } });
    }
    if (u === `${brokerUrl}/v1/info`) return jsonResponse({ service:'direct-xfer-oauth-broker', version:'2', storage:true, google:googleReady, callbackUrl:`${brokerUrl}/v1/google/callback` });
    throw new Error(`unexpected fetch ${options.method || 'GET'} ${u}`);
  };
  try {
    const h = harness();
    const prepared = await h.call('/storage/oauth/broker-auto/prepare', { apiToken });
    assert.equal(prepared.statusCode, 200);
    assert.equal(prepared.payload.brokerUrl, brokerUrl);
    assert.equal(prepared.payload.google, false);
    assert.ok(prepared.payload.deploymentId);
    assert.equal(JSON.stringify(prepared.payload).includes(apiToken), false);
    assert.equal(requests.some((r) => r.authorization === `Bearer ${apiToken}`), true);

    const completed = await h.call('/storage/oauth/broker-auto/google', {
      deploymentId:prepared.payload.deploymentId,
      clientId:'1234567890-directxfer.apps.googleusercontent.com',
      clientSecret:'google-secret-value-123456',
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.payload.google, true);
    assert.equal(JSON.stringify(completed.payload).includes('google-secret-value-123456'), false);
    assert.deepEqual(h.audits.map((a) => a.action), ['oauth-broker-cloudflare-prepared','oauth-broker-cloudflare-ready']);
  } finally { global.fetch = originalFetch; }
});
