'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const express = require('express');

const { createHttpApplication } = require('../lib/server/http-application');
const { csvField } = require('../lib/core-utils');

function buildHttpApplication() {
  const requestContext = new AsyncLocalStorage();
  const httpApplication = createHttpApplication({
    ADMIN_ALLOW_ANY:true,
    ADMIN_ALLOWED_IPS:[],
    TRUST_PROXY:1,
    clientIp:(req) => req.ip || (req.socket && req.socket.remoteAddress) || '127.0.0.1',
    crypto,
    express,
    getSettings:() => ({}),
    ipInList:() => false,
    isLocalNetwork:() => true,
    isLoopback:() => true,
    localCaModeActive:() => false,
    parseIpList:() => [],
    path,
    requestContext,
    rootDir:path.resolve(__dirname, '..'),
    sendError:(_req, res, status) => res.status(status).end(),
  });
  httpApplication.app.get('/probe', (_req, res) => res.status(200).json({ ok:true }));
  httpApplication.app.post('/probe', express.json(), (_req, res) => res.status(200).json({ ok:true }));
  httpApplication.app.get('/api/probe', (_req, res) => res.status(200).json({ ok:true }));
  return httpApplication.app;
}

async function withServer(fn) {
  const app = buildHttpApplication();
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    await fn(address.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host:'127.0.0.1',
      port,
      path:options.path || '/',
      method:options.method || 'GET',
      headers:options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status:res.statusCode,
        headers:res.headers,
        body:Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

test('ASVS V4.1.4 rejects TRACE before application routes', async () => {
  await withServer(async (port) => {
    const response = await request(port, { method:'TRACE', path:'/probe' });
    assert.equal(response.status, 405);
    assert.match(String(response.headers.allow || ''), /GET/);
    assert.match(String(response.headers.allow || ''), /POST/);
    assert.equal(JSON.parse(response.body).error, 'method-not-allowed');
  });
});

test('ASVS V3.4.1 and V3.4.7 emit subdomain HSTS and CSP reporting on HTTPS', async () => {
  await withServer(async (port) => {
    const response = await request(port, {
      method:'GET',
      path:'/probe',
      headers:{ 'x-forwarded-proto':'https' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
    assert.match(String(response.headers['content-security-policy'] || ''), /report-uri \/__csp-report/);
  });
});

test('ASVS V3.4.7 CSP report endpoint is bounded and returns no content', async () => {
  await withServer(async (port) => {
    const payload = JSON.stringify({
      'csp-report': {
        'document-uri':'https://example.invalid/app/',
        'effective-directive':'script-src-elem',
        'blocked-uri':'https://evil.invalid/payload.js',
      },
    });
    const response = await request(port, {
      method:'POST',
      path:'/__csp-report',
      headers:{
        'content-type':'application/csp-report',
        'content-length':Buffer.byteLength(payload),
      },
    }, payload);
    assert.equal(response.status, 204);
    assert.equal(response.body, '');
    assert.equal(response.headers['cache-control'], 'no-store');
  });
});

test('ASVS V3.5.8 blocks cross-site state changes using Fetch Metadata', async () => {
  await withServer(async (port) => {
    const response = await request(port, {
      method:'POST',
      path:'/probe',
      headers:{
        'sec-fetch-site':'cross-site',
        'sec-fetch-mode':'cors',
        'content-type':'application/json',
      },
    }, '{}');
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error, 'cross-site-request-blocked');
    assert.equal(response.headers['cache-control'], 'no-store');
  });
});

test('ASVS V3.5.8 protects authenticated API resources from cross-site subresource reads', async () => {
  await withServer(async (port) => {
    const blocked = await request(port, {
      method:'GET',
      path:'/api/probe',
      headers:{
        'sec-fetch-site':'cross-site',
        'sec-fetch-mode':'cors',
        'sec-fetch-dest':'empty',
      },
    });
    assert.equal(blocked.status, 403);
    assert.equal(JSON.parse(blocked.body).error, 'cross-site-request-blocked');
    assert.equal(blocked.headers['cross-origin-resource-policy'], 'same-origin');

    // Legacy/non-browser clients without Fetch Metadata remain compatible.
    const sameOriginCompatible = await request(port, { method:'GET', path:'/api/probe' });
    assert.equal(sameOriginCompatible.status, 200);
    assert.equal(sameOriginCompatible.headers['cross-origin-resource-policy'], 'same-origin');
  });
});

test('ASVS V1.2.10 prefixes every spreadsheet formula/control lead byte including NUL', () => {
  for (const prefix of ['=', '+', '-', '@', '\t', '\r', '\0']) {
    const value = prefix + '2+2';
    const encoded = csvField(value);
    assert.equal(encoded[0], "'", `missing formula prefix escape for ${JSON.stringify(prefix)}`);
  }
  assert.equal(csvField('safe'), 'safe');
  assert.equal(csvField('a,b'), '"a,b"');
});