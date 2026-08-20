'use strict';

function cleanFolderName(value) {
  const raw = String(value == null ? '' : value);
  const name = raw.trim();
  if (!name || name.length > 255) return null;
  if (name !== raw || name === '.' || name === '..') return null;
  if (/[\\/\0-\x1f\x7f]/.test(name)) return null;
  return name;
}

function createStorageConnectorBrowserRoutes(deps) {
  const {
    adminRouter, requireFullAdmin, storageConnectorService, getStorageConnector,
    cleanConnectorPath, connectorErrorCode, connectorHttpStatus, auditReq,
  } = deps || {};
  if (!adminRouter || typeof adminRouter.get !== 'function' || typeof adminRouter.post !== 'function') throw new TypeError('adminRouter is required');
  if (typeof requireFullAdmin !== 'function' || !storageConnectorService || typeof getStorageConnector !== 'function') throw new TypeError('storage connector dependencies are required');

  adminRouter.get('/storage/connectors/:id/list', requireFullAdmin, async (req, res) => {
    const connector = getStorageConnector(req.params.id);
    if (!connector) return res.status(404).json({ error:'not-found' });
    const relative = cleanConnectorPath(req.query.path || '');
    if (relative === null) return res.status(400).json({ error:'invalid-remote-path' });
    try { return res.json({ path:relative, entries:await storageConnectorService.list(connector, relative) }); }
    catch (error) {
      const code = connectorErrorCode(error), status = connectorHttpStatus(code);
      return res.status(status).json({ error:code });
    }
  });

  adminRouter.post('/storage/connectors/:id/mkdir', requireFullAdmin, async (req, res) => {
    const connector = getStorageConnector(req.params.id);
    if (!connector) return res.status(404).json({ error:'not-found' });
    if (connector.readOnly) return res.status(403).json({ error:'read-only' });
    const parentPath = cleanConnectorPath(req.body && req.body.parentPath || '');
    const name = cleanFolderName(req.body && req.body.name);
    if (parentPath === null || !name) return res.status(400).json({ error:'invalid-folder-name' });
    const remotePath = cleanConnectorPath([parentPath, name].filter(Boolean).join('/'), false);
    if (remotePath === null) return res.status(400).json({ error:'invalid-folder-name' });
    try {
      const entries = await storageConnectorService.list(connector, parentPath);
      if (entries.some((entry) => entry && String(entry.name || '') === name)) return res.status(409).json({ error:'folder-exists' });
      await storageConnectorService.mkdir(connector, remotePath);
      if (typeof auditReq === 'function') auditReq(req, 'storage-connector-folder-created', `${connector.name}: ${remotePath}`);
      return res.status(201).json({ ok:true, name, path:remotePath });
    } catch (error) {
      const code = connectorErrorCode(error), status = connectorHttpStatus(code);
      return res.status(status).json({ error:code });
    }
  });
}

module.exports = { createStorageConnectorBrowserRoutes, cleanFolderName };
