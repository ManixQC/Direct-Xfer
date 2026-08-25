'use strict';

const { createStorageConnectorConfigRoutes } = require('./storage-connector-config');
const { createOAuthBrokerDeploymentRoutes } = require('./oauth-broker-deployment');
const { createStorageConnectorBrowserRoutes } = require('./storage-connector-browser');

/**
 * Registers all authenticated storage-connector administration endpoints.
 * Connector execution/storage helpers remain services supplied by the composition
 * root; this module owns HTTP request/response semantics and route wiring.
 */
function attachAdminStorageRoutes(deps = {}) {
  const {
    adminRouter,
    requireFullAdmin,
    storageConnectorService,
    googleOAuthProfileStore,
    googleOAuthBrokerClient,
    connectorTypes,
    oauthConnectorTypes,
    connectorBackendType,
    safeRcloneErrorDetail,
    crypto,
    isLoopback,
    clientIp,
    auditReq,
    logAudit,
    getAccountById,
    googleOAuthPublicOrigin,
    googleOAuthBrokerUrl,
    googleOAuthBrokerManaged,
    ASVS_L3_MODE,
    ASVS_L3_EGRESS_ALLOWLIST,
    getStorageConnector,
    cleanConnectorPath,
    connectorErrorCode,
    connectorHttpStatus,
    connectorStore,
    publicConnector,
    normalizeConnector,
    maxStorageConnectors,
    persistNow,
    webStorageShareReferencesConnector,
    connectorJobService,
  } = deps;

  if (!adminRouter) throw new TypeError('admin-storage-routes requires adminRouter');
  const requiredJobMethods = [
    'invalidateProbe',
    'probeForConfiguration',
    'pruneJobs',
    'publicJob',
    'isConnectorBusy',
    'queueJob',
    'cancelJob',
  ];
  if (!connectorJobService
    || requiredJobMethods.some((name) => typeof connectorJobService[name] !== 'function')) {
    throw new TypeError('admin-storage-routes requires complete connectorJobService');
  }
  const {
    invalidateProbe,
    probeForConfiguration,
    pruneJobs,
    publicJob,
    isConnectorBusy,
    queueJob,
    cancelJob,
  } = connectorJobService;

  createStorageConnectorConfigRoutes({
    adminRouter,
    requireFullAdmin,
    storageConnectorService,
    googleOAuthProfileStore,
    googleOAuthBrokerClient,
    CONNECTOR_TYPES: connectorTypes,
    OAUTH_CONNECTOR_TYPES: oauthConnectorTypes,
    connectorBackendType,
    safeRcloneErrorDetail,
    crypto,
    isLoopback,
    clientIp,
    auditReq,
    logAudit,
    getAccountById,
    invalidateConnectorProbe:invalidateProbe,
    googleOAuthPublicOrigin,
    googleOAuthBrokerUrl,
    googleOAuthBrokerManaged,
    ASVS_L3_MODE,
    ASVS_L3_EGRESS_ALLOWLIST,
  });
  createOAuthBrokerDeploymentRoutes({ adminRouter, requireFullAdmin, crypto, auditReq, ASVS_L3_MODE, ASVS_L3_EGRESS_ALLOWLIST });
  createStorageConnectorBrowserRoutes({
    adminRouter,
    requireFullAdmin,
    storageConnectorService,
    getStorageConnector,
    cleanConnectorPath,
    connectorErrorCode,
    connectorHttpStatus,
    auditReq,
  });

  adminRouter.get('/storage/connectors/summary', requireFullAdmin, (req, res) => {
    const connectors = connectorStore().map(publicConnector).filter(Boolean);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      configured: connectors.length,
      writable: connectors.filter((connector) => !connector.readOnly).length,
    });
  });

  adminRouter.get('/storage/connectors', requireFullAdmin, async (req, res) => {
    let probe;
    try {
      probe = await probeForConfiguration();
    } catch (error) {
      probe = {
        capabilities: {
          available: false,
          error: String((error && (error.code || error.message)) || 'rclone-unavailable').slice(0, 120),
        },
        remotes: [],
      };
    }
    const capabilities = (probe && probe.capabilities) || { available: false, error: 'rclone-unavailable' };
    const remotes = Array.isArray(probe && probe.remotes) ? probe.remotes : [];
    const publicCapabilities = {
      available: !!capabilities.available,
      pending: !!capabilities.pending,
      version: ASVS_L3_MODE ? null : (capabilities.version ? String(capabilities.version).slice(0, 160) : null),
      error: capabilities.error ? String(capabilities.error).slice(0, 120) : null,
    };
    let connectors = [];
    let jobs = [];
    try { connectors = connectorStore().map(publicConnector).filter(Boolean); } catch (_) {}
    try { jobs = pruneJobs().map(publicJob).filter(Boolean); } catch (_) {}
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      connectors,
      jobs,
      capabilities: publicCapabilities,
      remotes,
      types: Array.from(connectorTypes),
    });
  });

  adminRouter.post('/storage/connectors', requireFullAdmin, (req, res) => {
    let connector;
    try {
      connector = normalizeConnector(req.body || {});
    } catch (error) {
      return res.status(400).json({ error: error.message || 'invalid-connector' });
    }
    const list = connectorStore();
    // Exact POST retries are idempotent so a transient UI retry cannot duplicate metadata.
    const existing = list.find((item) => item
      && String(item.name || '') === connector.name
      && String(item.type || '') === connector.type
      && String(item.remote || '') === connector.remote
      && String(item.root || '') === String(connector.root || '')
      && !!item.readOnly === !!connector.readOnly);
    if (existing) {
      const connectors = list.map(publicConnector).filter(Boolean);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ connector: publicConnector(existing), connectors, duplicate: true });
    }
    if (list.length >= maxStorageConnectors) return res.status(409).json({ error: 'too-many-connectors' });
    connector.id = crypto.randomBytes(12).toString('hex');
    list.push(connector);
    if (!persistNow()) {
      list.pop();
      return res.status(503).json({ error: 'write-error' });
    }
    auditReq(req, 'storage-connector-created', `${connector.name} (${connector.type}/${connector.remote})`);
    const connectors = connectorStore().map(publicConnector).filter(Boolean);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(201).json({ connector: publicConnector(connector), connectors });
  });

  adminRouter.patch('/storage/connectors/:id', requireFullAdmin, (req, res) => {
    const current = getStorageConnector(req.params.id);
    if (!current) return res.status(404).json({ error: 'not-found' });
    let next;
    try {
      next = normalizeConnector(req.body || {}, current);
    } catch (error) {
      return res.status(400).json({ error: error.message || 'invalid-connector' });
    }
    const references = webStorageShareReferencesConnector(current.id);
    if (references.length && (
      next.remote !== current.remote
      || next.root !== current.root
      || next.type !== current.type
    )) {
      return res.status(409).json({ error: 'connector-used-by-web-share', references: references.slice(0, 20) });
    }
    if (references.some((reference) => reference.writable) && !current.readOnly && next.readOnly) {
      return res.status(409).json({ error: 'connector-used-by-web-share', references: references.slice(0, 20) });
    }
    const before = { ...current };
    Object.assign(current, next, { id: before.id, createdAt: before.createdAt });
    if (!persistNow()) {
      Object.assign(current, before);
      return res.status(503).json({ error: 'write-error' });
    }
    auditReq(req, 'storage-connector-updated', `${current.name} (${current.type}/${current.remote})`);
    const connectors = connectorStore().map(publicConnector).filter(Boolean);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ connector: publicConnector(current), connectors });
  });

  adminRouter.delete('/storage/connectors/:id', requireFullAdmin, (req, res) => {
    const list = connectorStore();
    const index = list.findIndex((item) => item && item.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'not-found' });
    const references = webStorageShareReferencesConnector(req.params.id);
    if (references.length) {
      return res.status(409).json({ error: 'connector-used-by-web-share', references: references.slice(0, 20) });
    }
    if (isConnectorBusy(req.params.id)) {
      return res.status(409).json({ error: 'connector-busy' });
    }
    const [removed] = list.splice(index, 1);
    if (!persistNow()) {
      list.splice(index, 0, removed);
      return res.status(503).json({ error: 'write-error' });
    }
    auditReq(req, 'storage-connector-deleted', `${removed.name} (${removed.type}/${removed.remote})`);
    return res.json({ ok: true });
  });

  adminRouter.post('/storage/connectors/:id/test', requireFullAdmin, async (req, res) => {
    const connector = getStorageConnector(req.params.id);
    if (!connector) return res.status(404).json({ error: 'not-found' });
    try {
      const result = await storageConnectorService.test(connector);
      auditReq(req, 'storage-connector-tested', `${connector.name}: ok`);
      return res.json(result);
    } catch (error) {
      const code = connectorErrorCode(error);
      auditReq(req, 'storage-connector-tested', `${connector.name}: ${code}`);
      return res.status(502).json({ error: code });
    }
  });

  adminRouter.post('/storage/connectors/:id/import', requireFullAdmin, (req, res) => {
    const connector = getStorageConnector(req.params.id);
    if (!connector) return res.status(404).json({ error: 'not-found' });
    try {
      return res.status(202).json({
        job: publicJob(queueJob(req, connector, 'import', req.body || {})),
      });
    } catch (error) {
      const status = error.code === 'write-error' ? 503
        : error.code === 'connector-capacity' ? 429 : 400;
      return res.status(status).json({ error: error.code || 'invalid-job' });
    }
  });

  adminRouter.post('/storage/connectors/:id/export', requireFullAdmin, (req, res) => {
    const connector = getStorageConnector(req.params.id);
    if (!connector) return res.status(404).json({ error: 'not-found' });
    if (connector.readOnly) return res.status(403).json({ error: 'read-only' });
    try {
      return res.status(202).json({
        job: publicJob(queueJob(req, connector, 'export', req.body || {})),
      });
    } catch (error) {
      const status = error.code === 'write-error' ? 503
        : error.code === 'connector-capacity' ? 429 : 400;
      return res.status(status).json({ error: error.code || 'invalid-job' });
    }
  });

  adminRouter.post('/storage/jobs/:id/cancel', requireFullAdmin, (req, res) => {
    if (!cancelJob(req.params.id)) return res.status(404).json({ error: 'not-found' });
    auditReq(req, 'storage-connector-cancelled', req.params.id);
    return res.json({ ok: true });
  });
}

module.exports = { attachAdminStorageRoutes };
