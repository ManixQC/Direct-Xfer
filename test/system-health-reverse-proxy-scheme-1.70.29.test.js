'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { resolveHealthPublicScheme, projectHealthForRequest } = require('../lib/server/admin-dashboard-routes');

const root = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(url, child, logs, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}\n${logs.join('')}`);
    try { const response = await fetch(url); if (response.ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server timeout\n${logs.join('')}`);
}

function cookieHeader(response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(',').map((value) => value.split(';')[0]).filter(Boolean).join('; ');
}

test('health public scheme prefers trusted request HTTPS and preserves the internal origin scheme', () => {
  const deep = { config:{ scheme:'http', publicUrl:null } };
  assert.deepEqual(resolveHealthPublicScheme({ protocol:'https' }, deep), { scheme:'https', source:'request' });
  const projected = projectHealthForRequest({ protocol:'https' }, deep);
  assert.equal(projected.config.scheme, 'https');
  assert.equal(projected.config.originScheme, 'http');
  assert.equal(projected.config.schemeSource, 'request');
  assert.equal(deep.config.scheme, 'http', 'cached deep health snapshot must not be mutated');
});

test('configured HTTPS public URL describes the client-facing scheme when TLS terminates at the proxy', () => {
  const projected = projectHealthForRequest({ protocol:'http' }, { config:{ scheme:'http', publicUrl:'https://files.example.test' } });
  assert.equal(projected.config.scheme, 'https');
  assert.equal(projected.config.originScheme, 'http');
  assert.equal(projected.config.schemeSource, 'public-url');
});

test('untrusted forwarded HTTPS does not override an HTTP deployment without a configured public URL', () => {
  const projected = projectHealthForRequest({ protocol:'http', headers:{ 'x-forwarded-proto':'https' } }, { config:{ scheme:'http', publicUrl:null } });
  assert.equal(projected.config.scheme, 'http');
  assert.equal(projected.config.originScheme, 'http');
});

test('real trusted reverse proxy reports HTTPS in System Health while Node listens on HTTP', { timeout:30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-health-proxy-17029-'));
  const dirs = Object.fromEntries(['host','data','images','inbox'].map((name) => [name, path.join(temp, name)]));
  Object.values(dirs).forEach((directory) => fs.mkdirSync(directory, { recursive:true }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd:root,
    env:{
      ...process.env,
      PORT:String(port), HOST_ROOT:dirs.host, DATA_DIR:dirs.data, IMAGES_DIR:dirs.images, INBOX_DIR:dirs.inbox,
      ADMIN_USERNAME:'admin', ADMIN_PASSWORD:'HealthProxyPass123!', UPDATE_CHECK:'false', PUBLIC_URL:'',
      TRUST_PROXY:'127.0.0.1/32',
    },
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data', (data) => logs.push(data.toString()));
  child.stderr.on('data', (data) => logs.push(data.toString()));
  try {
    await waitFor(`${base}/healthz`, child, logs);
    const login = await fetch(`${base}/api/login`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ username:'admin', password:'HealthProxyPass123!' }),
    });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = cookieHeader(login);
    const response = await fetch(`${base}/api/server-health-dashboard`, {
      headers:{ Cookie:cookie, 'X-Forwarded-Proto':'https', 'X-Forwarded-Host':'files.example.test' },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.edge.protocol, 'https');
    assert.equal(body.edge.secure, true);
    assert.equal(body.edge.forwardedTrusted, true);
    assert.equal(body.deep.config.scheme, 'https');
    assert.equal(body.deep.config.originScheme, 'http');
    assert.equal(body.deep.config.schemeSource, 'request');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.rmSync(temp, { recursive:true, force:true });
  }
});
