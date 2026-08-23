'use strict';

/**
 * Direct-Xfer application-context publication boundary.
 *
 * The large set of composition-root domains used to be registered one-by-one in
 * server.js. Keeping the mapping here makes ownership explicit and lets the
 * application context prevalidate the complete direct-domain batch before any of
 * it becomes visible to route composition.
 */
const coreUtils = require('../core-utils');
const storageConnectors = require('../storage-connectors');
const photoUtils = require('../photo-utils');
const authUtils = require('../auth-utils');
const fileContentUtils = require('../file-content-utils');
const textRender = require('../text-render');
const dlpUtils = require('../dlp-utils');

const DIRECT_APPLICATION_DOMAINS = Object.freeze([
  'config', 'platform', 'core-utils', 'storage-connectors', 'photo-utils',
  'auth-utils', 'file-content-utils', 'text-render', 'dlp-utils', 'state-store',
  'settings', 'account', 'network', 'share-presentation', 'activity', 'audit',
  'restore', 'session', 'auth', 'tls-manager', 'runtime-constants', 'early-adapters',
]);

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`application domain registrar requires ${label}`);
  }
  return value;
}

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`application domain registrar requires ${label}()`);
  return value;
}

function requiredValue(source, name, label) {
  if (!Object.prototype.hasOwnProperty.call(source, name) || source[name] == null) {
    throw new TypeError(`application domain registrar requires ${label}.${name}`);
  }
  return source[name];
}

function createApplicationDomainEntries(options = {}) {
  const platform = requiredObject(options.platform, 'platform');
  const services = requiredObject(options.services, 'services');
  const runtimeConstants = requiredObject(options.runtimeConstants, 'runtimeConstants');
  const earlyAdapters = requiredObject(options.earlyAdapters, 'earlyAdapters');
  const config = requiredObject(options.config, 'config');

  const entries = [
    ['config', config],
    ['platform', platform],
    ['core-utils', coreUtils],
    ['storage-connectors', storageConnectors],
    ['photo-utils', photoUtils],
    ['auth-utils', authUtils],
    ['file-content-utils', fileContentUtils],
    ['text-render', textRender],
    ['dlp-utils', dlpUtils],
    ['state-store', requiredValue(services, 'stateStore', 'services')],
    ['settings', requiredValue(services, 'settingsService', 'services')],
    ['account', requiredValue(services, 'accountService', 'services')],
    ['network', requiredValue(services, 'networkServices', 'services')],
    ['share-presentation', requiredValue(services, 'sharePresentationService', 'services')],
    ['activity', requiredValue(services, 'activityPresenceService', 'services')],
    ['audit', requiredValue(services, 'auditService', 'services')],
    ['restore', requiredValue(services, 'restoreService', 'services')],
    ['session', requiredValue(services, 'sessionService', 'services')],
    ['auth', requiredValue(services, 'authService', 'services')],
    ['tls-manager', requiredValue(services, 'tlsManager', 'services')],
    ['runtime-constants', runtimeConstants],
    ['early-adapters', earlyAdapters],
  ];

  return Object.freeze(entries.map(([name, source]) => Object.freeze([name, source])));
}

function registerApplicationDomains(options = {}) {
  const applicationContext = requiredObject(options.applicationContext, 'applicationContext');
  requiredFunction(applicationContext.registerMany, 'applicationContext.registerMany');
  const entries = createApplicationDomainEntries(options);

  // registerMany performs all validation before its first mutation. Keep this as
  // one batch: splitting it back into sequential register() calls would re-open
  // the partial-publication failure mode this boundary exists to prevent.
  return applicationContext.registerMany(entries);
}

module.exports = {
  DIRECT_APPLICATION_DOMAINS,
  createApplicationDomainEntries,
  registerApplicationDomains,
};
