'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attachWindowsLauncherRoutes } = require('../lib/server/windows-launcher-routes');

function routeHarness(overrides = {}) {
  const routes = new Map();
  const app = {
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  };
  const state = {
    envManaged:false,
    fresh:true,
    initialPassword:'Generated!123',
    owner:{ id:'owner-1', username:'owner', ah:'hash-1', role:'owner' },
    cleared:0,
    sessionsCleared:[],
    audits:[],
    passwordUpdates:[],
    shutdowns:[],
    parserRuns:0,
  };
  const express = { urlencoded:() => (_req, _res, next) => { state.parserRuns += 1; next(); } };
  const deps = {
    APP_NAME:'Direct-Xfer',
    APP_VERSION:'1.70.3',
    ADMIN_USERNAME:'admin',
    DX_WINDOWS_LAUNCHER_TOKEN:'launcher-secret',
    accountService:{
      clearInitialPassword() { state.cleared += 1; state.fresh = false; },
      hasFreshInitialPassword() { return state.fresh; },
      initialPassword() { return state.initialPassword; },
      isEnvironmentPasswordManaged() { return state.envManaged; },
    },
    app,
    clearSessionsOfAccount(id) { state.sessionsCleared.push(id); },
    crypto,
    express,
    logAudit(action, payload) { state.audits.push([action, payload]); },
    ownerAccount() { return state.owner; },
    async setAccountPassword(owner, password, opts) {
      state.passwordUpdates.push([owner, password, opts]);
      return { ok:true };
    },
    shutdown(signal) { state.shutdowns.push(signal); },
    ...overrides,
  };
  const service = attachWindowsLauncherRoutes(deps);
  return { routes, state, service };
}

function req({ address='127.0.0.1', token='launcher-secret', query={}, body={} } = {}) {
  return {
    socket:{ remoteAddress:address }, query, body,
    get(name) { return name.toLowerCase() === 'x-direct-xfer-launcher-token' ? token : ''; },
  };
}

function res() {
  return {
    statusCode:200, headers:Object.create(null), body:undefined, ended:false, typeValue:null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    json(value) { this.body = value; return this; },
    type(value) { this.typeValue = value; return this; },
    send(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

async function invoke(routes, method, route, request, response) {
  const handlers = routes.get(`${method} ${route}`);
  assert.ok(handlers, `missing ${method} ${route}`);
  let index = 0;
  let fellThrough = false;
  const run = async () => {
    const handler = handlers[index++];
    if (!handler) { fellThrough = true; return; }
    let nextCalled = false;
    let skipRoute = false;
    const next = (arg) => {
      if (arg === 'route') skipRoute = true;
      else nextCalled = true;
    };
    await handler(request, response, next);
    if (skipRoute) { fellThrough = true; return; }
    if (nextCalled) await run();
  };
  await run();
  return fellThrough;
}

test('server composition delegates every private Windows launcher route to the extracted module', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const moduleSource = fs.readFileSync(path.join(root, 'lib/server/windows-launcher-routes.js'), 'utf8');
  const finalHttp = fs.readFileSync(path.join(root, 'lib/server/final-http-application.js'), 'utf8');
  const composition = fs.readFileSync(path.join(root, 'lib/server/http-pwa-lifecycle-application.js'), 'utf8');
  assert.match(server, /require\('\.\/lib\/server\/final-http-application'\)/);
  assert.match(finalHttp, /require\('\.\/http-pwa-lifecycle-application'\)/);
  assert.match(composition, /attachWindowsLauncherRoutes\(\{/);
  assert.match(composition, /require\('\.\/windows-launcher-routes'\)/);
  for (const route of [
    'initial-admin-password', 'reset-admin-password-ticket',
    'reset-admin-password', 'ready', 'shutdown',
  ]) {
    assert.doesNotMatch(server, new RegExp(`app\\.(?:get|post)\\('/__dx_launcher/${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(moduleSource, new RegExp(`/__dx_launcher/${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

test('launcher token stays loopback-only and disabled deployments fall through invisibly', async () => {
  const h = routeHarness();
  let response = res();
  await invoke(h.routes, 'GET', '/__dx_launcher/ready', req({ address:'192.168.1.20' }), response);
  assert.equal(response.statusCode, 404);

  response = res();
  await invoke(h.routes, 'GET', '/__dx_launcher/ready', req({ token:'wrong' }), response);
  assert.equal(response.statusCode, 404);

  const disabled = routeHarness({ DX_WINDOWS_LAUNCHER_TOKEN:'' });
  response = res();
  const fellThrough = await invoke(disabled.routes, 'GET', '/__dx_launcher/ready', req(), response);
  assert.equal(fellThrough, true);
  assert.equal(response.body, undefined);
});

test('initial password is returned once to the authenticated launcher and then consumed', async () => {
  const h = routeHarness();
  const response = res();
  await invoke(h.routes, 'POST', '/__dx_launcher/initial-admin-password', req(), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok:true, fresh:true, username:'owner', password:'Generated!123',
  });
  assert.equal(response.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(h.state.cleared, 1);

  const second = res();
  await invoke(h.routes, 'POST', '/__dx_launcher/initial-admin-password', req(), second);
  assert.equal(second.statusCode, 204);
  assert.equal(second.body, undefined);
  assert.equal(h.state.cleared, 1);
});

test('reset ticket remains browser-usable only on loopback and successful reset revokes it', async () => {
  const h = routeHarness();
  const ticketResponse = res();
  await invoke(h.routes, 'POST', '/__dx_launcher/reset-admin-password-ticket', req(), ticketResponse);
  assert.equal(ticketResponse.body.ok, true);
  assert.equal(ticketResponse.body.expiresIn, 120);
  assert.ok(ticketResponse.body.ticket.length >= 40);
  const ticket = ticketResponse.body.ticket;

  const page = res();
  await invoke(h.routes, 'GET', '/__dx_launcher/reset-admin-password', req({ query:{ ticket, lang:'fr' } }), page);
  assert.equal(page.statusCode, 200);
  assert.equal(page.typeValue, 'html');
  assert.match(page.body, /Réinitialiser le mot de passe admin/);
  assert.match(page.body, new RegExp(ticket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(page.headers['cache-control'], 'no-store, max-age=0');
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);

  const remotePage = res();
  await invoke(h.routes, 'GET', '/__dx_launcher/reset-admin-password', req({ address:'10.0.0.8', query:{ ticket } }), remotePage);
  assert.equal(remotePage.statusCode, 404);

  const reset = res();
  await invoke(h.routes, 'POST', '/__dx_launcher/reset-admin-password', req({ body:{ ticket, lang:'en', password:'NewPassword!9', confirm:'NewPassword!9' } }), reset);
  assert.equal(reset.statusCode, 200);
  assert.match(reset.body, /Administrator password reset/);
  assert.equal(h.state.passwordUpdates.length, 1);
  assert.equal(h.state.sessionsCleared[0], 'owner-1');
  assert.equal(h.state.audits[0][0], 'password-reset');

  const reused = res();
  await invoke(h.routes, 'GET', '/__dx_launcher/reset-admin-password', req({ query:{ ticket } }), reused);
  assert.equal(reused.statusCode, 410);
});

test('readiness is process-specific and shutdown acknowledges before scheduling lifecycle stop', async () => {
  const h = routeHarness();
  const ready = res();
  await invoke(h.routes, 'GET', '/__dx_launcher/ready', req(), ready);
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.ok, true);
  assert.equal(ready.body.app, 'Direct-Xfer');
  assert.equal(ready.body.version, '1.70.3');
  assert.equal(ready.body.pid, process.pid);

  const stopping = res();
  await invoke(h.routes, 'POST', '/__dx_launcher/shutdown', req(), stopping);
  assert.equal(stopping.statusCode, 202);
  assert.deepEqual(stopping.body, { ok:true });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual(h.state.shutdowns, ['windows-server-host']);
});
