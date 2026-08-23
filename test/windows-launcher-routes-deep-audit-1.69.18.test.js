'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { attachWindowsLauncherRoutes } = require('../lib/server/windows-launcher-routes');

function makeHarness(overrides = {}) {
  const routes = new Map();
  const state = {
    envManaged:false,
    fresh:true,
    initialPassword:'Generated!123',
    owner:{ id:'owner-1', username:'owner', ah:'hash-1', role:'owner' },
    parserRuns:0,
    passwordUpdates:0,
    sessionsCleared:0,
    audits:0,
    shutdowns:0,
  };
  const app = {
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  };
  const express = {
    urlencoded:() => (_req, _res, next) => { state.parserRuns += 1; next(); },
  };
  const deps = {
    APP_NAME:'Direct-Xfer',
    APP_VERSION:'1.70.0',
    ADMIN_USERNAME:'admin',
    DX_WINDOWS_LAUNCHER_TOKEN:'launcher-secret',
    accountService:{
      clearInitialPassword() { state.fresh = false; },
      hasFreshInitialPassword() { return state.fresh; },
      initialPassword() { return state.initialPassword; },
      isEnvironmentPasswordManaged() { return state.envManaged; },
    },
    app,
    clearSessionsOfAccount() { state.sessionsCleared += 1; },
    crypto,
    express,
    logAudit() { state.audits += 1; },
    ownerAccount() { return state.owner; },
    async setAccountPassword(owner, password, opts) {
      state.passwordUpdates += 1;
      if (typeof opts.beforeCommit === 'function' && !opts.beforeCommit()) {
        return { ok:false, error:'not-authorized' };
      }
      owner.ah = `changed:${password}`;
      return { ok:true };
    },
    shutdown() { state.shutdowns += 1; },
    ...overrides,
  };
  attachWindowsLauncherRoutes(deps);
  return { routes, state };
}

function request({ address='127.0.0.1', token='launcher-secret', query={}, body={} } = {}) {
  return {
    socket:{ remoteAddress:address },
    query,
    body,
    get(name) { return name.toLowerCase() === 'x-direct-xfer-launcher-token' ? token : ''; },
  };
}

function response() {
  return {
    statusCode:200,
    headers:Object.create(null),
    body:undefined,
    ended:false,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    json(value) { this.body = value; return this; },
    type() { return this; },
    send(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

async function invoke(routes, method, route, req, res) {
  const handlers = routes.get(`${method} ${route}`);
  assert.ok(handlers, `missing ${method} ${route}`);
  let index = 0;
  let fellThrough = false;
  const run = async () => {
    const handler = handlers[index++];
    if (!handler) { fellThrough = true; return; }
    let nextCalled = false;
    let skipRoute = false;
    let nextError = null;
    const next = (arg) => {
      if (arg === 'route') skipRoute = true;
      else if (arg) nextError = arg;
      else nextCalled = true;
    };
    await handler(req, res, next);
    if (nextError) throw nextError;
    if (skipRoute) { fellThrough = true; return; }
    if (nextCalled) await run();
  };
  await run();
  return fellThrough;
}

async function issueTicket(h) {
  const res = response();
  await invoke(h.routes, 'POST', '/__dx_launcher/reset-admin-password-ticket', request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  return res.body.ticket;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('browser reset body parsing is gated before disabled or non-loopback requests', async () => {
  const disabled = makeHarness({ DX_WINDOWS_LAUNCHER_TOKEN:'' });
  let res = response();
  const fellThrough = await invoke(disabled.routes, 'POST', '/__dx_launcher/reset-admin-password', request(), res);
  assert.equal(fellThrough, true);
  assert.equal(disabled.state.parserRuns, 0);

  const remote = makeHarness();
  res = response();
  await invoke(remote.routes, 'POST', '/__dx_launcher/reset-admin-password', request({ address:'192.168.50.10' }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(remote.state.parserRuns, 0);

  res = response();
  await invoke(remote.routes, 'POST', '/__dx_launcher/reset-admin-password', request({ body:{ ticket:'invalid' } }), res);
  assert.equal(res.statusCode, 410);
  assert.equal(remote.state.parserRuns, 1);
});

test('loopback validation accepts the Windows variants but rejects non-loopback mapped addresses', async () => {
  const h = makeHarness();
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    const res = response();
    await invoke(h.routes, 'GET', '/__dx_launcher/ready', request({ address }), res);
    assert.equal(res.statusCode, 200, address);
  }
  for (const address of ['192.168.1.1', '::ffff:192.168.1.1', '::ffff:c0a8:101', '127.0.0.999']) {
    const res = response();
    await invoke(h.routes, 'GET', '/__dx_launcher/ready', request({ address }), res);
    assert.equal(res.statusCode, 404, address);
  }
});

test('reset tickets are bound to the exact owner credential state and account object', async () => {
  const h = makeHarness();
  let ticket = await issueTicket(h);
  h.state.owner.ah = 'hash-2';
  let res = response();
  await invoke(h.routes, 'GET', '/__dx_launcher/reset-admin-password', request({ query:{ ticket } }), res);
  assert.equal(res.statusCode, 410);

  h.state.owner.ah = 'hash-3';
  ticket = await issueTicket(h);
  h.state.owner = { ...h.state.owner };
  res = response();
  await invoke(h.routes, 'GET', '/__dx_launcher/reset-admin-password', request({ query:{ ticket } }), res);
  assert.equal(res.statusCode, 410);
});

test('a reset ticket is single-flight so concurrent submissions cannot both commit', async () => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const h = makeHarness({
    async setAccountPassword(owner, password, opts) {
      calls += 1;
      started.resolve();
      await release.promise;
      if (!opts.beforeCommit()) return { ok:false, error:'not-authorized' };
      owner.ah = `changed:${password}`;
      return { ok:true };
    },
  });
  const ticket = await issueTicket(h);
  const body = { ticket, lang:'en', password:'NewPassword!9', confirm:'NewPassword!9' };
  const firstRes = response();
  const first = invoke(h.routes, 'POST', '/__dx_launcher/reset-admin-password', request({ body }), firstRes);
  await started.promise;

  const secondRes = response();
  await invoke(h.routes, 'POST', '/__dx_launcher/reset-admin-password', request({ body }), secondRes);
  assert.equal(secondRes.statusCode, 410);
  assert.equal(calls, 1);

  release.resolve();
  await first;
  assert.equal(firstRes.statusCode, 200);
  assert.equal(h.state.sessionsCleared, 1);
  assert.equal(h.state.audits, 1);
});

test('issuing a newer recovery ticket invalidates an older reset already hashing', async () => {
  const started = deferred();
  const release = deferred();
  const h = makeHarness({
    async setAccountPassword(_owner, _password, opts) {
      started.resolve();
      await release.promise;
      return opts.beforeCommit() ? { ok:true } : { ok:false, error:'not-authorized' };
    },
  });
  const oldTicket = await issueTicket(h);
  const body = { ticket:oldTicket, lang:'en', password:'NewPassword!9', confirm:'NewPassword!9' };
  const resetRes = response();
  const resetPromise = invoke(h.routes, 'POST', '/__dx_launcher/reset-admin-password', request({ body }), resetRes);
  await started.promise;

  const newTicket = await issueTicket(h);
  assert.notEqual(newTicket, oldTicket);
  release.resolve();
  await resetPromise;
  assert.equal(resetRes.statusCode, 409);
  assert.equal(h.state.sessionsCleared, 0);
  assert.equal(h.state.audits, 0);
});

test('unexpected password-update failures release the claim for a safe retry', async () => {
  let calls = 0;
  const h = makeHarness({
    async setAccountPassword(owner, password, opts) {
      calls += 1;
      if (calls === 1) throw new Error('simulated hashing failure');
      if (!opts.beforeCommit()) return { ok:false, error:'not-authorized' };
      owner.ah = `changed:${password}`;
      return { ok:true };
    },
  });
  const ticket = await issueTicket(h);
  const body = { ticket, lang:'en', password:'NewPassword!9', confirm:'NewPassword!9' };

  let res = response();
  await invoke(h.routes, 'POST', '/__dx_launcher/reset-admin-password', request({ body }), res);
  assert.equal(res.statusCode, 503);
  assert.match(String(res.body), new RegExp(ticket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  res = response();
  await invoke(h.routes, 'POST', '/__dx_launcher/reset-admin-password', request({ body }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 2);
});

test('private launcher responses consistently disable caching', async () => {
  const h = makeHarness();
  for (const [method, route] of [
    ['GET', '/__dx_launcher/ready'],
    ['POST', '/__dx_launcher/initial-admin-password'],
    ['POST', '/__dx_launcher/reset-admin-password-ticket'],
  ]) {
    const res = response();
    await invoke(h.routes, method, route, request(), res);
    assert.match(res.headers['cache-control'] || '', /no-store/);
    assert.equal(res.headers.pragma, 'no-cache');
  }
});
