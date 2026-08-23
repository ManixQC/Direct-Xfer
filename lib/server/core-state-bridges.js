'use strict';

/**
 * Late/core bridge facade for the root-state application.
 *
 * server.js owns the high-level application order, while this module owns the
 * small compatibility surface needed by core-state-application before several
 * later domains (share/media, security, public HTTP and PWA) are available.
 * Provider references stay live through bootstrap-reference-registry and the
 * PWA registry; no concrete late service is captured here.
 */
const { normalizeLinkBase } = require('./share-presentation-service');
const { normalizeTags } = require('./admin-share-routes');
const { cleanBrokerUrl } = require('../google-oauth-broker-client');

const SHARE_PRESENTATION_METHODS = Object.freeze([
  'displayStatsForShare', 'isActive', 'isScheduled', 'linkPrefix', 'parseMaxVisitors',
  'shareActivityAt', 'shareBackingHealthSnapshot', 'shareEffectiveExpiry',
  'shareFirstUseDeadline', 'shareInactiveDeadline', 'shareItems', 'shareLastUseAt',
  'shareLogicalBytes', 'shareLogicalFileCount', 'shareNeedsLogicalBytesScan',
  'shareStatsBaseline',
]);
const PHOTO_PRESENTATION_METHODS = Object.freeze(['photoCacheRevision', 'photoStatsOf']);
const PWA_DEVICE_PRESENTATION_METHODS = Object.freeze(['photoUploadDeviceName', 'shareCreatorDeviceName']);

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`core-state bridges require ${name}()`);
  return value;
}

function requiredObject(value, name) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError(`core-state bridges require ${name}`);
  }
  return value;
}

function ownDataValue(source, property, label) {
  const descriptor = source && Object.getOwnPropertyDescriptor(source, property);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new TypeError(`core-state bridge contract mismatch: ${label}.${property} must be an own data property`);
  }
  return descriptor.value;
}

function ownFunctionValue(source, property, label) {
  const descriptor = source && Object.getOwnPropertyDescriptor(source, property);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new TypeError(`core-state bridge contract mismatch: ${label}.${property} must be an own function`);
  }
  return descriptor.value;
}

function validateFunctions(source, properties, label) {
  for (const property of properties) ownFunctionValue(source, property, label);
  return source;
}

function createCoreStateBridges(options = {}) {
  const bootstrapReferences = requiredObject(options.bootstrapReferences, 'bootstrapReferences');
  const refs = requiredObject(bootstrapReferences.refs, 'bootstrapReferences.refs');
  const current = requiredFunction(bootstrapReferences.current, 'bootstrapReferences.current');
  const pwaRegistry = requiredObject(options.pwaRegistry, 'pwaRegistry');
  const pwaCurrent = requiredFunction(pwaRegistry.current, 'pwaRegistry.current');
  const getServerScheme = requiredFunction(options.getServerScheme, 'getServerScheme');
  const clientIp = requiredFunction(options.clientIp, 'clientIp');

  function ref(name) {
    return requiredFunction(refs[name], `bootstrapReferences.refs.${name}`);
  }

  function currentService(namespace, label) {
    const service = current(namespace);
    if (!service || (typeof service !== 'object' && typeof service !== 'function')) {
      throw new Error(`core-state bridge provider not ready: ${label}`);
    }
    return service;
  }

  function currentPwaDeviceService() {
    const service = pwaCurrent.call(pwaRegistry, 'device');
    if (!service || (typeof service !== 'object' && typeof service !== 'function')) {
      throw new Error('core-state bridge provider not ready: pwa device service');
    }
    return service;
  }

  function getShareService() {
    const service = currentService('share', 'share service');
    validateFunctions(service, SHARE_PRESENTATION_METHODS, 'share service');
    const logicalBytesCache = ownDataValue(service, 'shareLogicalBytesCache', 'share service');
    if (!(logicalBytesCache instanceof Map)) {
      throw new TypeError('core-state bridge contract mismatch: share service.shareLogicalBytesCache must be a Map');
    }
    return service;
  }

  function getPhotoService() {
    return validateFunctions(
      currentService('photo', 'photo service'),
      PHOTO_PRESENTATION_METHODS,
      'photo service',
    );
  }

  function getPwaDeviceService() {
    return validateFunctions(
      currentPwaDeviceService(),
      PWA_DEVICE_PRESENTATION_METHODS,
      'pwa device service',
    );
  }

  function getPwaDevices(...args) {
    const service = currentPwaDeviceService();
    return ownFunctionValue(service, 'pwaDevices', 'pwa device service').apply(service, args);
  }

  return Object.freeze({
    getServerScheme,
    clientIp,
    scheduleSearchReindex:ref('scheduleSearchReindex'),
    resetMailerCache:ref('resetMailerCache'),
    emailSendable:ref('emailSendable'),
    pushSubs:ref('pushSubs'),
    normalizeLinkBase,
    cleanBrokerUrl,
    parseHotlinkHosts:ref('parseHotlinkHosts'),
    normalizeShareColor:ref('normalizeShareColor'),
    normalizeTags,
    normalizeDescriptionMd:ref('normalizeDescriptionMd'),
    normExtList:ref('runtimeNormExtList'),
    addAdminCenterNotification:ref('addAdminCenterNotification'),
    noteCenterServiceState:ref('noteCenterServiceState'),
    getShareService,
    getPhotoService,
    getPwaDeviceService,
    getShareById:ref('getById'),
    getTrashItems:ref('trashItems'),
    getPwaDevices,
    isSessionActive:ref('isSessionActive'),
    getActiveTransfers:() => {
      const transferService = currentService('transfer', 'transfer service');
      const activeTransfers = ownDataValue(transferService, 'activeTransfers', 'transfer service');
      if (!(activeTransfers instanceof Map)) {
        throw new TypeError('core-state bridge contract mismatch: transfer service.activeTransfers must be a Map');
      }
      return activeTransfers;
    },
  });
}

module.exports = {
  SHARE_PRESENTATION_METHODS,
  PHOTO_PRESENTATION_METHODS,
  PWA_DEVICE_PRESENTATION_METHODS,
  createCoreStateBridges,
};
