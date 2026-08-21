'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
const { createStorageConnectorBrowserRoutes, cleanFolderName } = require('../lib/server/storage-connector-browser');

function response() {
  return {
    statusCode:200, body:null,
    status(code){ this.statusCode=code; return this; },
    json(body){ this.body=body; return this; },
  };
}
function routeHarness(overrides = {}) {
  const routes = new Map(), calls = [];
  const router = {
    get(route, ...handlers){ routes.set(`GET ${route}`, handlers.at(-1)); },
    post(route, ...handlers){ routes.set(`POST ${route}`, handlers.at(-1)); },
  };
  const connector = { id:'c1', name:'Google Drive', remote:'Direct-Xfer', root:'', readOnly:false };
  const service = {
    list:async()=>[],
    mkdir:async(_connector, remotePath)=>{ calls.push(remotePath); return { target:remotePath }; },
    ...overrides.service,
  };
  createStorageConnectorBrowserRoutes({
    adminRouter:router,
    requireFullAdmin:(_req,_res,next)=>next && next(),
    storageConnectorService:service,
    getStorageConnector:()=>overrides.connector === undefined ? connector : overrides.connector,
    cleanConnectorPath:(value, allowEmpty=true)=>{
      const raw=String(value == null ? '' : value);
      if (!raw) return allowEmpty ? '' : null;
      if (raw.startsWith('/') || raw.includes('..') || /[\0-\x1f\x7f]/.test(raw)) return null;
      return raw.split('/').filter(Boolean).join('/');
    },
    connectorErrorCode:(error)=>String(error && error.code || 'connector-failed'),
    connectorHttpStatus:()=>502,
    auditReq:()=>{},
  });
  return { routes, calls, connector };
}

test('1.69.2 web-reception browser exposes an in-modal new-folder workflow', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const css = read('public/style.css');
  assert.match(html, /id="web-storage-new-folder"/);
  assert.match(html, /id="web-storage-new-folder-row"/);
  assert.match(html, /id="web-storage-new-folder-name"/);
  assert.match(app, /webStorageMode!==['"]share['"]/);
  assert.match(app, /\/api\/storage\/connectors\/\$\{encodeURIComponent\(connectorId\)\}\/mkdir/);
  assert.match(app, /await loadWebStoragePath\(createdPath\);\s*webStorageSetSelection\(createdPath,true,createdName\)/);
  assert.match(css, /\.web-storage-new-folder\s*\{/);
});

test('1.69.2 folder names are single safe remote path segments', () => {
  assert.equal(cleanFolderName('Client uploads'), 'Client uploads');
  for (const bad of ['', ' ', '.', '..', ' nested ', 'a/b', 'a\\b', 'bad\nname']) assert.equal(cleanFolderName(bad), null);
});

test('1.69.2 writable connector mkdir creates the folder and returns its selectable path', async () => {
  const h = routeHarness();
  const handler = h.routes.get('POST /storage/connectors/:id/mkdir');
  const res = response();
  await handler({ params:{id:'c1'}, body:{parentPath:'Incoming', name:'August'} }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { ok:true, name:'August', path:'Incoming/August' });
  assert.deepEqual(h.calls, ['Incoming/August']);
});

test('1.69.2 mkdir rejects duplicates and read-only connectors without mutating cloud storage', async () => {
  let h = routeHarness({ service:{ list:async()=>[{name:'August', path:'Incoming/August', isDir:true}] } });
  let res = response();
  await h.routes.get('POST /storage/connectors/:id/mkdir')({ params:{id:'c1'}, body:{parentPath:'Incoming', name:'August'} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'folder-exists');
  assert.deepEqual(h.calls, []);

  h = routeHarness({ connector:{ id:'c1', name:'Read only', remote:'r', root:'', readOnly:true } });
  res = response();
  await h.routes.get('POST /storage/connectors/:id/mkdir')({ params:{id:'c1'}, body:{parentPath:'', name:'New'} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'read-only');
});
