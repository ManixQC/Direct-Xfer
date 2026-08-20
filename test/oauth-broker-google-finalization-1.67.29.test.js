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
  const adminRouter = { post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); } };
  createOAuthBrokerDeploymentRoutes({
    adminRouter,
    requireFullAdmin(_req, _res, next) { if (next) next(); },
    crypto,
    auditReq() {},
  });
  return async function call(route, body) {
    let statusCode = 200; let payload;
    const req = { body, session:{ accountId:'owner-1' } };
    const res = { status(code) { statusCode = code; return this; }, json(value) { payload = value; return this; }, setHeader() {} };
    await routes.get(`POST ${route}`)(req, res);
    return { statusCode, payload };
  };
}

test('1.68.0 waits for Cloudflare Google-secret propagation instead of failing on the first stale google:false response', async () => {
  const accountId = 'a'.repeat(32);
  const databaseId = '11111111-2222-3333-4444-555555555555';
  const brokerUrl = 'https://direct-xfer-oauth-broker.example-subdomain.workers.dev';
  const apiToken = 'cf_test_token_abcdefghijklmnopqrstuvwxyz0123456789';
  let googleSecretsWritten = false;
  let postSecretHealthCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.endsWith('/user/tokens/verify')) return jsonResponse({ success:true, result:{ status:'active' } });
    if (u.endsWith('/accounts?per_page=50')) return jsonResponse({ success:true, result:[{ id:accountId, name:'Test' }] });
    if (u.endsWith(`/accounts/${accountId}/workers/subdomain`)) return jsonResponse({ success:true, result:{ subdomain:'example-subdomain' } });
    if (u.includes(`/accounts/${accountId}/d1/database?name=`)) return jsonResponse({ success:true, result:[{ uuid:databaseId, name:'direct-xfer-oauth-broker' }] });
    if (u.endsWith(`/accounts/${accountId}/d1/database/${databaseId}/query`)) {
      const raw = options.body ? JSON.parse(options.body) : {};
      if (String(raw.sql || '').includes('COUNT(*) AS count')) return jsonResponse({ success:true, result:[{ results:[{ count:0 }] }] });
      return jsonResponse({ success:true, result:[{ results:[] }] });
    }
    if (u.endsWith(`/accounts/${accountId}/workers/scripts/direct-xfer-oauth-broker/secrets`) && (options.method || 'GET') === 'GET') return jsonResponse({ success:false, errors:[{ message:'not found' }] }, 404);
    if (u.endsWith(`/accounts/${accountId}/workers/scripts/direct-xfer-oauth-broker`) && options.method === 'PUT') return jsonResponse({ success:true, result:{ id:'direct-xfer-oauth-broker' } });
    if (u.endsWith(`/accounts/${accountId}/workers/scripts/direct-xfer-oauth-broker/subdomain`) && options.method === 'POST') return jsonResponse({ success:true, result:{ enabled:true } });
    if (u.endsWith(`/accounts/${accountId}/workers/scripts/direct-xfer-oauth-broker/secrets`) && options.method === 'PUT') {
      const secret = JSON.parse(options.body);
      if (secret.name === 'GOOGLE_CLIENT_SECRET' && secret.text !== 'bootstrap.disabled') googleSecretsWritten = true;
      return jsonResponse({ success:true, result:{ name:secret.name, type:'secret_text' } });
    }
    if (u === `${brokerUrl}/v1/info`) {
      if (googleSecretsWritten) postSecretHealthCalls += 1;
      const google = googleSecretsWritten && postSecretHealthCalls >= 2;
      return jsonResponse({ service:'direct-xfer-oauth-broker', version:'2', storage:true, google, callbackUrl:`${brokerUrl}/v1/google/callback` });
    }
    throw new Error(`unexpected fetch ${options.method || 'GET'} ${u}`);
  };
  try {
    const call = harness();
    const prepared = await call('/storage/oauth/broker-auto/prepare', { apiToken });
    assert.equal(prepared.statusCode, 200);
    const completed = await call('/storage/oauth/broker-auto/google', {
      deploymentId:prepared.payload.deploymentId,
      clientId:'1234567890-directxfer.apps.googleusercontent.com',
      clientSecret:'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4',
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.payload.google, true);
    assert.ok(postSecretHealthCalls >= 2, 'finalization must retry after stale google:false');
  } finally {
    global.fetch = originalFetch;
  }
});

test('1.68.0 surfaces Google-secret propagation as a specific stage instead of the generic deployment failure', () => {
  const server = read('lib/server/oauth-broker-deployment.js');
  const app = read('public/app.js');
  assert.match(server, /waitForGoogleBrokerReady/);
  assert.match(server, /atStage\('google-propagation'/);
  assert.match(server, /oauth-broker-google-propagation-pending/);
  assert.match(app, /'google-propagation':t\('connector\.googleBrokerStageGoogle'\)/);
  assert.match(app, /connector\.googleBrokerGooglePropagation/);
  assert.match(app, /broker-auto\/google'[\s\S]*120000/);
});
