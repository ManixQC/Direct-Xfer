'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { ROUTE_DEPENDENCIES, createApplicationContext } = require('../lib/server/application-context');
const { createApplicationDomainEntries } = require('../lib/server/register-application-domains');
const {
  APPLICATION_DOMAIN_CONTRACTS,
  RECEPTION_COLLABORATION_DOMAINS,
  publishApplicationGraph,
} = require('../lib/server/application-publication');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function directOptions() {
  return {
    config:{},
    platform:{ express },
    services:{
      stateStore:{}, settingsService:{}, accountService:{}, networkServices:{},
      sharePresentationService:{}, activityPresenceService:{}, auditService:{}, restoreService:{},
      sessionService:{}, authService:{}, tlsManager:{},
    },
    runtimeConstants:{},
    earlyAdapters:{},
  };
}

function applicationFrom(names, sources) {
  return Object.freeze({
    applicationDomainEntries() {
      return Object.freeze(names.map((name) => Object.freeze([name, sources[name] || Object.create(null)])));
    },
  });
}

function fakeRouter() {
  const routes = [];
  const router = Object.create(null);
  for (const verb of ['get', 'post']) {
    router[verb] = (routePath, ...handlers) => {
      routes.push({ verb, routePath, handlers });
      return router;
    };
  }
  return { router, routes };
}

function completeApplications(direct) {
  const sources = Object.create(null);
  for (const names of Object.values(APPLICATION_DOMAIN_CONTRACTS)) {
    for (const name of names) sources[name] = Object.create(null);
  }

  const { router, routes } = fakeRouter();
  sources['public-share'].downloadRouter = router;

  const directEntries = createApplicationDomainEntries(direct);
  const providers = [
    ...directEntries.filter(([name]) => RECEPTION_COLLABORATION_DOMAINS.includes(name)),
    ...Object.entries(sources).filter(([name]) => RECEPTION_COLLABORATION_DOMAINS.includes(name)),
  ];
  for (const dependency of ROUTE_DEPENDENCIES.receptionCollaboration) {
    if (dependency === 'PENDING_DIR' || dependency === 'live' || dependency === 'downloadRouter') continue;
    const count = providers.reduce((n, [, source]) => n + (Object.prototype.hasOwnProperty.call(source, dependency) ? 1 : 0), 0);
    if (count === 0) sources.upload[dependency] = () => undefined;
  }

  return {
    sources,
    router,
    applications:{
      runtimeServicesApplication:applicationFrom(APPLICATION_DOMAIN_CONTRACTS.runtimeServicesApplication, sources),
      notificationApplication:applicationFrom(APPLICATION_DOMAIN_CONTRACTS.notificationApplication, sources),
      shareMediaTransferApplication:applicationFrom(APPLICATION_DOMAIN_CONTRACTS.shareMediaTransferApplication, sources),
      publicHttpApplication:applicationFrom(APPLICATION_DOMAIN_CONTRACTS.publicHttpApplication, sources),
    },
    routes,
  };
}

test('priority 5 moves global domain publication and reception attachment out of server.js', () => {
  const server = read('server.js');
  const publication = read('lib/server/application-publication.js');
  assert.match(server, /publishApplicationGraph\(\{/);
  assert.doesNotMatch(server, /\.registerApplicationDomains\(\)/);
  assert.doesNotMatch(server, /attachReceptionCollaborationRoutes\(/);
  assert.match(publication, /const publishedDomains = registerMany\(entries\)/);
  assert.match(publication, /attachReceptionCollaborationRoutes\(preflightFacade\)/);
  assert.match(publication, /attachReceptionCollaborationRoutes\(receptionFacade\)/);
  assert.ok(server.split('\n').length < 640, `server.js should stay compact after priority 5 (${server.split('\n').length} lines)`);
});

test('publication boundary rejects application namespace drift before touching the production context', () => {
  const direct = directOptions();
  const context = createApplicationContext();
  const good = completeApplications(direct).applications;
  const bad = {
    ...good,
    runtimeServicesApplication:applicationFrom(['upload', 'maintenance', 'backup'], {
      upload:{}, maintenance:{}, backup:{},
    }),
  };
  assert.throws(
    () => publishApplicationGraph({
      applicationContext:context,
      direct,
      applications:bad,
      reception:{ PENDING_DIR:'/tmp/pending', live:{} },
    }),
    /domain contract mismatch for runtimeServicesApplication/,
  );
  assert.deepEqual(context.domains(), []);
});

test('reception route contract is preflighted before the real application graph is published', () => {
  const direct = directOptions();
  const context = createApplicationContext();
  const sources = Object.create(null);
  for (const names of Object.values(APPLICATION_DOMAIN_CONTRACTS)) {
    for (const name of names) sources[name] = Object.create(null);
  }
  const applications = {
    runtimeServicesApplication:applicationFrom(APPLICATION_DOMAIN_CONTRACTS.runtimeServicesApplication, sources),
    notificationApplication:applicationFrom(APPLICATION_DOMAIN_CONTRACTS.notificationApplication, sources),
    shareMediaTransferApplication:applicationFrom(APPLICATION_DOMAIN_CONTRACTS.shareMediaTransferApplication, sources),
    publicHttpApplication:applicationFrom(APPLICATION_DOMAIN_CONTRACTS.publicHttpApplication, sources),
  };
  assert.throws(
    () => publishApplicationGraph({
      applicationContext:context,
      direct,
      applications,
      reception:{ PENDING_DIR:'/tmp/pending', live:{} },
    }),
    /application route receptionCollaboration is missing/,
  );
  assert.deepEqual(context.domains(), []);
});

test('publication boundary commits every application namespace in one batch then attaches reception routes', () => {
  const direct = directOptions();
  const context = createApplicationContext();
  const fixture = completeApplications(direct);
  const result = publishApplicationGraph({
    applicationContext:context,
    direct,
    applications:fixture.applications,
    reception:{ PENDING_DIR:'/tmp/pending', live:{} },
  });

  assert.deepEqual(context.domains(), result.publishedDomains);
  assert.deepEqual(
    context.domains().slice(0, APPLICATION_DOMAIN_CONTRACTS.runtimeServicesApplication.length),
    APPLICATION_DOMAIN_CONTRACTS.runtimeServicesApplication,
  );
  for (const name of RECEPTION_COLLABORATION_DOMAINS) assert.ok(context.current(name), `missing ${name}`);
  assert.ok(fixture.routes.length >= 20, 'writable reception/collaboration routes should attach after publication');
});


test('real reception router contract is validated before the production graph is committed', () => {
  const direct = directOptions();
  const context = createApplicationContext();
  const fixture = completeApplications(direct);
  fixture.sources['public-share'].downloadRouter = {
    get() { return this; },
  };

  assert.throws(
    () => publishApplicationGraph({
      applicationContext:context,
      direct,
      applications:fixture.applications,
      reception:{ PENDING_DIR:'/tmp/pending', live:{} },
    }),
    /requires reception downloadRouter\.get\(\) and downloadRouter\.post\(\)/,
  );
  assert.deepEqual(context.domains(), []);
});

test('real downloadRouter ambiguity is not hidden by the side-effect-free route preflight override', () => {
  const direct = directOptions();
  const context = createApplicationContext();
  const fixture = completeApplications(direct);
  fixture.sources.upload.downloadRouter = fixture.router;

  assert.throws(
    () => publishApplicationGraph({
      applicationContext:context,
      direct,
      applications:fixture.applications,
      reception:{ PENDING_DIR:'/tmp/pending', live:{} },
    }),
    /ambiguous application dependency downloadRouter/,
  );
  assert.deepEqual(context.domains(), []);
});

test('production context mutation during publication preflight aborts the global commit', () => {
  const direct = directOptions();
  const context = createApplicationContext();
  const fixture = completeApplications(direct);
  const runtime = fixture.applications.runtimeServicesApplication;
  const originalEntries = runtime.applicationDomainEntries;
  const mutatingRuntime = Object.freeze({
    applicationDomainEntries() {
      context.register('external-preflight-domain', Object.create(null));
      return originalEntries.call(runtime);
    },
  });

  assert.throws(
    () => publishApplicationGraph({
      applicationContext:context,
      direct,
      applications:{ ...fixture.applications, runtimeServicesApplication:mutatingRuntime },
      reception:{ PENDING_DIR:'/tmp/pending', live:{} },
    }),
    /application context changed during application publication preflight/,
  );
  assert.deepEqual(context.domains(), ['external-preflight-domain']);
});
