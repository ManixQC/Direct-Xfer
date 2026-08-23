'use strict';

/**
 * Process/platform dependency boundary for the Direct-Xfer composition root.
 *
 * Node built-ins, external HTTP/rendering packages and optional notification/TLS
 * packages used to be loaded individually in server.js. Keeping those loads here
 * gives the composition root stable, named dependency views while preserving the
 * historical optional-package behaviour (missing/broken optional packages degrade
 * to null instead of preventing the rest of the server from booting).
 */
const pwaAdminHealth = require('../pwa-admin-health-route');

const PLATFORM_VIEW_KEYS = Object.freeze({
  coreState:Object.freeze(['fs', 'path', 'crypto', 'os', 'net', 'tls', 'forge', 'nodemailer', 'webpush']),
  notification:Object.freeze(['nodemailer', 'webpush']),
  shareMediaTransfer:Object.freeze(['fs', 'crypto']),
  securityAuth:Object.freeze(['crypto']),
  publicHttp:Object.freeze(['express']),
  runtimeServices:Object.freeze(['fs', 'path', 'crypto', 'forge']),
  directDomains:Object.freeze(['fs', 'path', 'crypto', 'express', 'QRCode', 'nodemailer', 'webpush', 'forge', 'pwaAdminHealth']),
});

function requiredLoader(value) {
  if (typeof value !== 'function') throw new TypeError('platform dependencies require load()');
  return value;
}

function ownDataValue(source, name) {
  if ((typeof source !== 'object' && typeof source !== 'function') || source === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(source, name);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
}

function objectLike(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function');
}

function ownFunction(source, name) {
  return typeof ownDataValue(source, name) === 'function';
}

function requiredModule(load, name, validate) {
  const value = load(name);
  if (!validate(value)) throw new TypeError(`platform dependency ${name} has an incompatible export`);
  return value;
}

function requiredNamedFunction(load, moduleName, exportName) {
  const moduleValue = load(moduleName);
  // Node's async_hooks exposes AsyncLocalStorage through a built-in getter. This
  // is a required trusted runtime primitive, so read the named export once and
  // validate it immediately instead of imposing the data-property rule used for
  // optional third-party packages.
  const value = moduleValue == null ? undefined : moduleValue[exportName];
  if (typeof value !== 'function') {
    throw new TypeError(`platform dependency ${moduleName}.${exportName} has an incompatible export`);
  }
  return value;
}

function optionalModule(load, name, validate) {
  try {
    const value = load(name);
    return validate(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function validFs(value) {
  return objectLike(value) && ownFunction(value, 'readFileSync') && ownFunction(value, 'writeFileSync') && ownFunction(value, 'existsSync');
}
function validPath(value) {
  return objectLike(value) && ownFunction(value, 'join') && ownFunction(value, 'resolve') && ownFunction(value, 'dirname');
}
function validCrypto(value) {
  return objectLike(value) && ownFunction(value, 'createHash') && ownFunction(value, 'randomBytes') && ownFunction(value, 'timingSafeEqual');
}
function validOs(value) {
  return objectLike(value) && ownFunction(value, 'networkInterfaces');
}
function validNet(value) {
  return objectLike(value) && ownFunction(value, 'isIP');
}
function validTls(value) {
  return objectLike(value) && ownFunction(value, 'createServer');
}
function validExpress(value) {
  return typeof value === 'function' && ownFunction(value, 'Router');
}
function validQrCode(value) {
  return objectLike(value) && ownFunction(value, 'toString');
}
function validForge(value) {
  if (!objectLike(value)) return false;
  const pki = ownDataValue(value, 'pki');
  const md = ownDataValue(value, 'md');
  const sha256 = ownDataValue(md, 'sha256');
  return objectLike(pki)
    && ownFunction(pki, 'privateKeyFromPem')
    && ownFunction(pki, 'publicKeyFromPem')
    && ownFunction(pki, 'certificateFromPem')
    && ownFunction(pki, 'createCertificate')
    && ownFunction(pki, 'certificateToPem')
    && objectLike(ownDataValue(pki, 'oids'))
    && objectLike(md)
    && objectLike(sha256)
    && ownFunction(sha256, 'create');
}
function validNodemailer(value) {
  return objectLike(value) && ownFunction(value, 'createTransport');
}
function validWebpush(value) {
  return objectLike(value) && ownFunction(value, 'generateVAPIDKeys') && ownFunction(value, 'sendNotification');
}
function validPwaAdminHealth(value) {
  return objectLike(value)
    && ownFunction(value, 'healthPayload')
    && ownFunction(value, 'recordHealthHistory')
    && ownFunction(value, 'bucketHealthHistory')
    && ownFunction(value, 'attachHealthRoute');
}

function createView(dependencies, names) {
  const view = Object.create(null);
  for (const name of names) {
    Object.defineProperty(view, name, {
      enumerable:true,
      configurable:false,
      writable:false,
      value:dependencies[name],
    });
  }
  return Object.freeze(view);
}

function createPlatformDependencies(options = {}) {
  const load = requiredLoader(Object.prototype.hasOwnProperty.call(options, 'load') ? options.load : require);
  const internalPwaAdminHealth = Object.prototype.hasOwnProperty.call(options, 'pwaAdminHealth')
    ? options.pwaAdminHealth
    : pwaAdminHealth;
  if (!validPwaAdminHealth(internalPwaAdminHealth)) {
    throw new TypeError('platform dependency pwaAdminHealth has an incompatible export');
  }

  const EventEmitter = requiredNamedFunction(load, 'events', 'EventEmitter');
  const AsyncLocalStorage = requiredNamedFunction(load, 'async_hooks', 'AsyncLocalStorage');
  const dependencies = Object.freeze({
    fs:requiredModule(load, 'fs', validFs),
    path:requiredModule(load, 'path', validPath),
    crypto:requiredModule(load, 'crypto', validCrypto),
    os:requiredModule(load, 'os', validOs),
    net:requiredModule(load, 'net', validNet),
    tls:requiredModule(load, 'tls', validTls),
    EventEmitter,
    AsyncLocalStorage,
    express:requiredModule(load, 'express', validExpress),
    QRCode:requiredModule(load, 'qrcode', validQrCode),
    forge:optionalModule(load, 'node-forge', validForge),
    nodemailer:optionalModule(load, 'nodemailer', validNodemailer),
    webpush:optionalModule(load, 'web-push', validWebpush),
    pwaAdminHealth:internalPwaAdminHealth,
  });

  const views = Object.create(null);
  for (const [name, keys] of Object.entries(PLATFORM_VIEW_KEYS)) {
    views[name] = createView(dependencies, keys);
  }

  return Object.freeze({
    ...dependencies,
    views:Object.freeze(views),
  });
}

module.exports = {
  PLATFORM_VIEW_KEYS,
  createPlatformDependencies,
};
