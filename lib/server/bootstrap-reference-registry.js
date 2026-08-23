'use strict';

const UNSAFE_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const SERVER_BOOTSTRAP_REFERENCE_CONTRACTS = Object.freeze({
  notification:Object.freeze(['resetMailerCache', 'emailSendable', 'pushSubs']),
  notificationCenter:Object.freeze(['addAdminCenterNotification', 'noteCenterServiceState']),
  share:Object.freeze([
    'getById', 'getByToken', 'isActive', 'isScheduled', 'listShares', 'trashItems',
    'normalizeShareColor', 'normalizeDescriptionMd', 'shareFirstUseDeadline',
    'shareInactiveDeadline', 'shareEffectiveExpiry', 'parseMaxVisitors',
    'centerPublicVisitorDeviceLabel', 'displayStatsForShare', 'linkPrefix',
    'shareActivityAt', 'shareBackingHealthSnapshot', 'shareItems', 'shareLastUseAt',
    'shareLogicalBytes', 'shareLogicalFileCount', 'shareNeedsLogicalBytesScan',
    'shareStatsBaseline',
  ]),
  search:Object.freeze(['scheduleReindex']),
  photo:Object.freeze(['photoStatsOf', 'photoCacheRevision']),
  transfer:Object.freeze(['listTransfers']),
  security:Object.freeze(['isSessionActive']),
  publicHttp:Object.freeze(['parseHotlinkHosts']),
  runtime:Object.freeze([
    'receptionThreadEnabled', 'normExtList', 'folderMetrics', 'isBackupInFlight',
    'hasActiveUploads', 'isMaintenanceStateReplacementBusy',
    'clearUploadRuntimeAfterRestore', 'clearMaintenanceRuntimeState',
  ]),
  admin:Object.freeze(['currentAccount', 'ownsShare']),
  adminShareCore:Object.freeze(['resolveHostItem']),
});

function assertName(value, label) {
  if (typeof value !== 'string' || !value.trim() || UNSAFE_NAMES.has(value)) {
    throw new TypeError(`invalid bootstrap reference ${label}: ${String(value)}`);
  }
  return value;
}

function normalizeContracts(contracts) {
  if (!contracts || typeof contracts !== 'object' || Array.isArray(contracts)) {
    throw new TypeError('bootstrap reference contracts must be an object');
  }
  const normalized = new Map();
  for (const namespace of Object.keys(contracts)) {
    const safeNamespace = assertName(namespace, 'namespace');
    const operations = contracts[namespace];
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new TypeError(`bootstrap reference namespace ${safeNamespace} must declare operations`);
    }
    const seen = new Set();
    const list = [];
    for (const operation of operations) {
      const safeOperation = assertName(operation, `operation for ${safeNamespace}`);
      if (seen.has(safeOperation)) throw new Error(`duplicate bootstrap reference operation: ${safeNamespace}.${safeOperation}`);
      seen.add(safeOperation);
      list.push(safeOperation);
    }
    normalized.set(safeNamespace, Object.freeze(list));
  }
  if (!normalized.size) throw new TypeError('bootstrap reference contracts must not be empty');
  return normalized;
}

function ownFunction(source, namespace, operation) {
  const descriptor = Object.getOwnPropertyDescriptor(source, operation);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new TypeError(`bootstrap reference contract mismatch: ${namespace}.${operation} must be an own function`);
  }
  return descriptor.value;
}

function createBootstrapReferenceRegistry(contracts) {
  const declared = normalizeContracts(contracts);
  let bindings = new Map();
  let revision = 0;
  const facades = Object.create(null);

  function contract(namespace) {
    const name = assertName(namespace, 'namespace');
    const operations = declared.get(name);
    if (!operations) throw new TypeError(`unknown bootstrap reference namespace: ${name}`);
    return { name, operations };
  }

  for (const [namespace, operations] of declared) {
    const facade = Object.create(null);
    for (const operation of operations) {
      facade[operation] = function lazyBootstrapReference(...args) {
        const binding = bindings.get(namespace);
        if (!binding) throw new Error(`bootstrap-reference-not-ready:${namespace}.${operation}`);
        // Preserve the historical bridge semantics: the provider surface is live,
        // not a snapshot captured at bind time. Revalidate the own data property
        // on every call so a later deletion/accessor replacement fails closed
        // instead of invoking a stale implementation forever.
        return ownFunction(binding.source, namespace, operation).apply(binding.source, args);
      };
    }
    facades[namespace] = Object.freeze(facade);
  }
  Object.freeze(facades);

  function prepare(namespace, source) {
    const { name, operations } = contract(namespace);
    if (!source || (typeof source !== 'object' && typeof source !== 'function')) {
      throw new TypeError(`bootstrap reference source ${name} must be an object or function`);
    }
    return { name, source, operations };
  }

  function bindMany(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new TypeError('bootstrap reference binding batch must be a non-empty array');
    }
    const startRevision = revision;
    const prepared = [];
    const names = new Set();

    // First validate namespace identity/conflicts without touching provider
    // property descriptors. A rejected conflicting bind must be side-effect free
    // even when the candidate is a Proxy with hostile descriptor traps.
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new TypeError('bootstrap reference binding entries must be [namespace, source] pairs');
      }
      const item = prepare(entry[0], entry[1]);
      if (names.has(item.name)) throw new Error(`duplicate bootstrap reference namespace in batch: ${item.name}`);
      const existing = bindings.get(item.name);
      if (existing && existing.source !== item.source) throw new Error(`bootstrap reference namespace already bound: ${item.name}`);
      names.add(item.name);
      prepared.push(item);
    }

    // Only candidates that can actually participate in the batch are allowed to
    // expose their contract surface. Validate the whole batch before publication.
    for (const item of prepared) {
      for (const operation of item.operations) ownFunction(item.source, item.name, operation);
    }
    if (revision !== startRevision) throw new Error('bootstrap reference registry changed during binding preflight');
    const next = new Map(bindings);
    let changed = false;
    for (const item of prepared) {
      if (!next.has(item.name)) { next.set(item.name, item); changed = true; }
    }
    if (changed) { bindings = next; revision += 1; }
    return Object.freeze(prepared.map((item) => item.source));
  }

  function bind(namespace, source) { bindMany([[namespace, source]]); return source; }
  function current(namespace) { const item = bindings.get(contract(namespace).name); return item ? item.source : null; }

  return Object.freeze({
    refs:facades, bind, bindMany, current,
    namespaces:() => Object.freeze([...declared.keys()]),
  });
}

function createServerBootstrapReferences() {
  const registry = createBootstrapReferenceRegistry(SERVER_BOOTSTRAP_REFERENCE_CONTRACTS);
  const refs = Object.freeze({
    ...registry.refs.notification,
    ...registry.refs.notificationCenter,
    ...registry.refs.share,
    scheduleSearchReindex:registry.refs.search.scheduleReindex,
    isSessionActive:registry.refs.security.isSessionActive,
    parseHotlinkHosts:registry.refs.publicHttp.parseHotlinkHosts,
    receptionThreadEnabled:registry.refs.runtime.receptionThreadEnabled,
    runtimeNormExtList:registry.refs.runtime.normExtList,
    runtimeFolderMetrics:registry.refs.runtime.folderMetrics,
    runtimeIsBackupInFlight:registry.refs.runtime.isBackupInFlight,
    runtimeHasActiveUploads:registry.refs.runtime.hasActiveUploads,
    runtimeMaintenanceBusy:registry.refs.runtime.isMaintenanceStateReplacementBusy,
    clearRuntimeUploadsAfterRestore:registry.refs.runtime.clearUploadRuntimeAfterRestore,
    clearRuntimeMaintenanceAfterRestore:registry.refs.runtime.clearMaintenanceRuntimeState,
    ...registry.refs.admin,
    ...registry.refs.adminShareCore,
  });

  return Object.freeze({
    refs,
    bindNotification(application) {
      if (!application || typeof application !== 'object') throw new TypeError('notification application is required');
      registry.bindMany([
        ['notification', application.notificationService],
        ['notificationCenter', application.notificationCenterService],
      ]);
    },
    bindShareMediaTransfer(application) {
      if (!application || typeof application !== 'object') throw new TypeError('share-media-transfer application is required');
      registry.bindMany([
        ['share', application.shareService],
        ['search', application.searchService],
        ['photo', application.photoService],
        ['transfer', application.transferService],
      ]);
    },
    bindSecurity(application) {
      if (!application || typeof application !== 'object') throw new TypeError('security/auth application is required');
      registry.bind('security', application.sessionService);
    },
    bindPublicHttp(application) {
      if (!application || typeof application !== 'object') throw new TypeError('public HTTP application is required');
      registry.bind('publicHttp', application);
    },
    bindRuntime(application) { registry.bind('runtime', application); },
    bindAdmin(application) {
      if (!application || typeof application !== 'object') throw new TypeError('administrator application is required');
      registry.bindMany([['admin', application], ['adminShareCore', application.shareCoreOutput]]);
    },
    current:registry.current,
  });
}

module.exports = {
  SERVER_BOOTSTRAP_REFERENCE_CONTRACTS,
  createBootstrapReferenceRegistry,
  createServerBootstrapReferences,
};
