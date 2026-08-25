'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { StorageConnectorService } = require('../lib/storage-connectors');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const server = read('server.js') + '\n' + read('lib/server/public-share-routes.js') + '\n' + read('lib/server/share-service.js') + '\n' + read('lib/server/admin-share-routes.js');
const sharePresentation = read('lib/server/share-presentation-service.js');
const downloadService = read('lib/server/download-service.js');
const adminStorage = read('lib/server/admin-storage-routes.js');
const connectorJobService = read('lib/server/storage-connector-job-service.js');
const pwaRoutes = read('lib/server/pwa-routes.js');
const storage = read('lib/storage-connectors.js');
const webTools = read('lib/web-storage-share.js');
const pages = read('lib/server/public-pages.js');
const html = read('public/index.html');
const app = read('public/app.js');
const css = read('public/style.css');
const pwaApp = read('pwa/app.js');

function childOutput(child) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(Buffer.from(c)));
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`exit ${code}`)));
  });
}

test('web-storage share has a dedicated admin flow and cloud browser', () => {
  assert.match(html, /id="new-web-storage-btn"/);
  assert.match(html, /id="web-storage-overlay"/);
  assert.match(html, /id="web-storage-connector"/);
  assert.match(html, /id="web-storage-select-folder"/);
  assert.match(html, /id="web-storage-list"/);
  assert.match(app, /async function openWebStorageModal\(mode='share'\)/);
  assert.match(app, /\/api\/storage\/connectors\/\$\{encodeURIComponent\(connectorId\)\}\/list\?path=/);
  assert.match(app, /'\/api\/shares\/web-storage'/);
  assert.match(css, /\.web-storage-list/);
});

test('web-storage creation freezes connector routing and requires an explicit remotePath field', () => {
  assert.match(server, /adminRouter\.post\('\/shares\/web-storage', requireFullAdmin/);
  assert.match(server, /Object\.prototype\.hasOwnProperty\.call\(body, 'remotePath'\)/);
  assert.match(server, /webStorage:\{ \.\.\.webStorageConnectorSnapshot\(connector\)/);
  assert.match(server, /remote:String\(connector\.remote/);
  assert.match(server, /root:String\(connector\.root/);
  assert.match(server, /sourceName:String\(stat\.name/);
});

test('connector edits/deletion cannot silently redirect an existing cloud share', () => {
  assert.match(connectorJobService, /function webStorageShareReferencesConnector\(connectorId\)/);
  assert.match(adminStorage, /connector-used-by-web-share/);
  assert.match(adminStorage, /next\.remote !== current\.remote[\s\S]*?next\.root !== current\.root[\s\S]*?next\.type !== current\.type/);
  assert.match(server, /trashItems\(\)/);
});

test('remote content is not falsely claimed as DLP-scanned', () => {
  assert.match(server, /function webStorageDlpGate/);
  assert.match(server, /dlp-remote-unscanned/);
  assert.match(server, /filesSkipped:1/);
  assert.match(server, /scanErrors:1/);
  assert.match(server, /body\.dlpOverride !== true/);
  assert.match(app, /apiWithDlpOverride\('POST',endpoint,payload\)/);
});

test('cloud files and folders have public routes without local ZIP/checksum materialization', () => {
  assert.match(server, /s\.type === 'web-storage'/);
  assert.match(server, /serveWebStorageFile\(req, res, s/);
  assert.match(server, /webStorageFolderPage\(/);
  assert.match(server, /if \(s\.type === 'web-storage'\) return sendError\(req, res, 404, 'notFound'\);/);
  assert.match(server, /zip-unavailable-for-web-storage/);
  assert.match(server, /if \(s\.webStorage\) s\.allowZip = false/);
  assert.match(pages, /share\.type === 'web-storage' \? '' : `<p class="file-sums"/);
  assert.doesNotMatch(pages.slice(pages.indexOf('function webStorageFolderPage'), pages.indexOf('function errorPage')), /zip-select|\/sha256/);
});

test('renaming a cloud file does not destroy preview detection based on its real source name', () => {
  assert.match(pages, /const mediaName = share\.previewName \|\| share\.name/);
  assert.match(server, /previewName: String\(s\.webStorage && s\.webStorage\.sourceName/);
  assert.match(server, /previewInfo\(sourceName\)/);
});

test('remote stream supports byte ranges through rclone cat offset/count', () => {
  assert.match(storage, /const args = \['cat', remoteSpec\(connector, rel\)\]/);
  assert.match(storage, /args\.push\('--offset', String\(offset\)\)/);
  assert.match(storage, /args\.push\('--count', String\(count\)\)/);
  assert.match(downloadService, /Accept-Ranges', 'bytes'/);
  assert.match(downloadService, /Content-Range/);
  assert.match(webTools, /status:206/);
  assert.match(webTools, /multi-range/);
});

test('streaming waits for rclone exit status before ending HTTP success', () => {
  const block = downloadService.slice(downloadService.indexOf('function serveWebStorageFile'), downloadService.indexOf('function clearRuntimeState'));
  assert.match(block, /output\.pipe\(res, \{ end:false \}\)/);
  assert.match(block, /const maybeEndResponse = \(\) =>/);
  assert.match(block, /if \(childOk\) res\.end\(\)/);
  assert.match(block, /sendWebStorageStreamError/);
  assert.match(downloadService, /for \(const name of \['Content-Length','Content-Range','Content-Disposition'/);
  assert.match(downloadService, /res\.removeHeader\(name\)/);
});

test('remote validators include modification time before enabling If-Range ETags', () => {
  assert.doesNotMatch(storage.slice(storage.indexOf('async stat('), storage.indexOf('// Starts an rclone command')), /--no-modtime/);
  assert.match(storage, /modTime:row\.ModTime/);
  assert.match(webTools, /if \(!identity \|\| !modTime\) return null/);
  assert.match(downloadService, /Last-Modified/);
  assert.match(webTools, /ifRange && \(!etagValue \|\| ifRange !== etagValue\) \? null/);
  assert.match(downloadService, /webStorageStat\(s, relative, \{ fresh:!!req\.headers\['if-range'\] \}\)/);
});

test('remote folder root can be deliberately shared but omission is rejected', () => {
  assert.match(storage, /async stat\(connector, relative\) \{\n\s*const rel = cleanRelativePath\(relative\);/);
  assert.match(webTools, /const basePath = cleanRelativePath\(raw\.path\);/);
  assert.match(webTools, /if \(!meta\.path\) return full/);
  assert.match(server, /missing-remote-path/);
  assert.match(app, /webStorageSetSelection\(webStoragePath,true,webStoragePath\|\|'\/'\)/);
});

test('nested connector browsing always prefixes lsjson relative paths, including same-name children', async () => {
  const service = new StorageConnectorService({ bin:'unused', configPath:path.join(os.tmpdir(), 'dx-unused-rclone.conf'), importRoot:path.join(os.tmpdir(), 'dx-unused-import') });
  service.run = async () => ({ stdout:JSON.stringify([{ Name:'docs', Path:'docs', IsDir:false, Size:7 }]), stderr:'' });
  const rows = await service.list({ remote:'fake', root:'', name:'Fake' }, 'docs');
  assert.equal(rows[0].path, 'docs/docs');
  assert.match(storage, /Always prefix the requested base/);
});

test('root stat accepts a directory and carries provider modification time', async () => {
  const service = new StorageConnectorService({ bin:'unused', configPath:path.join(os.tmpdir(), 'dx-unused-rclone.conf'), importRoot:path.join(os.tmpdir(), 'dx-unused-import') });
  service.run = async (args) => {
    assert.deepEqual(args.slice(0,3), ['lsjson','fake:','--stat']);
    return { stdout:JSON.stringify({ Name:'', Path:'', IsDir:true, Size:-1, ID:'root-id', ModTime:'2026-08-18T12:00:00Z' }), stderr:'' };
  };
  const row = await service.stat({ remote:'fake', root:'', name:'My Drive' }, '');
  assert.equal(row.name, 'My Drive');
  assert.equal(row.isDir, true);
  assert.equal(row.modTime, '2026-08-18T12:00:00Z');
});

test('streamFile wrapper passes exact range and relays only requested bytes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-cloud-stream-'));
  const wrapper = path.join(temp, 'fake-rclone.js');
  fs.writeFileSync(wrapper, `
'use strict';
const a=process.argv.slice(2); if(a[0]!=='cat'||a[1]!=='fake:file.bin')process.exit(3);
const off=a.includes('--offset')?Number(a[a.indexOf('--offset')+1]):0;
const count=a.includes('--count')?Number(a[a.indexOf('--count')+1]):-1;
const b=Buffer.from('0123456789'); process.stdout.write(count<0?b.subarray(off):b.subarray(off,off+count));
`);
  const service = new StorageConnectorService({ bin:wrapper, configPath:path.join(temp, 'rclone.conf'), importRoot:path.join(temp, 'imports') });
  try {
    const child = service.streamFile({ remote:'fake', root:'', name:'Fake' }, 'file.bin', { offset:2, count:4 });
    const out = await childOutput(child);
    assert.equal(out.toString(), '2345');
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});

test('admin cards and editor recognize web-storage instead of mislabelling it as a local file', () => {
  assert.match(app, /s\.type === 'web-storage' \? t\('sh\.webStorage'\)/);
  assert.match(app, /isWebStorage \? '☁'/);
  assert.match(app, /s\.type === 'file' \|\| s\.type === 'folder' \|\| s\.type === 'web-storage'/);
  assert.match(app, /\$\('edit-allowzip'\)\.disabled = !!s\.webStorage/);
});

test('web-storage public/admin metadata omits frozen rclone remote/root from decorated browser data', () => {
  const start = sharePresentation.indexOf('webStorage: shareRecord.webStorage ?');
  assert.ok(start >= 0, 'web-storage projection lives in share-presentation-service');
  const block = sharePresentation.slice(start, sharePresentation.indexOf('album: shareRecord.type', start));
  assert.match(block, /connectorId/);
  assert.match(block, /sourceName/);
  assert.doesNotMatch(block, /remote:/);
  assert.doesNotMatch(block, /root:/);
});



test('cloud share creation rejects a connector route that changed while remote stat was in flight', () => {
  const block = server.slice(server.indexOf("adminRouter.post('/shares/web-storage'"), server.indexOf("adminRouter.post('/shares',", server.indexOf("adminRouter.post('/shares/web-storage'")));
  assert.match(block, /const connector = Object\.freeze\(\{ \.\.\.currentConnector \}\)/);
  assert.match(block, /const recheckedConnector = getStorageConnector\(connector\.id\)/);
  assert.match(block, /recheckedConnector\.remote !== connector\.remote/);
  assert.match(block, /connector-changed-during-create/);
});

test('successful cloud byte ranges count toward the per-link bytes-served cap', () => {
  const block = downloadService.slice(downloadService.indexOf('function serveWebStorageFile'), downloadService.indexOf('function clearRuntimeState'));
  assert.match(block, /completed && !inline && countStats[\s\S]*?noteBytesServed\(s\.id, expected\)/);
  assert.doesNotMatch(block, /noteBytesServed\(s\.id, total\)/);
});

test('stderr chatter cannot keep a stalled cloud payload stream alive forever', () => {
  const block = downloadService.slice(downloadService.indexOf('function serveWebStorageFile'), downloadService.indexOf('function clearRuntimeState'));
  const stderrLine = block.split('\n').find((line) => line.includes("child.stderr.on('data'")) || '';
  assert.ok(stderrLine);
  assert.doesNotMatch(stderrLine, /touchIdle/);
  assert.match(block, /child\.stdout\.on\('data'.*touchIdle\(\)/);
});

test('ambiguous cloud paths with leading or trailing whitespace are rejected instead of retargeted', () => {
  assert.match(storage, /const normalized = String\(value == null \? '' : value\)/);
  assert.match(storage, /if \(raw !== normalized\) return null/);
  const { cleanRelativePath } = require('../lib/storage-connectors');
  assert.equal(cleanRelativePath(' report.pdf'), null);
  assert.equal(cleanRelativePath('report.pdf '), null);
  assert.equal(cleanRelativePath('folder/report.pdf'), 'folder/report.pdf');
});

test('cloud-link modal clears account-specific remote data on logout and supports Escape', () => {
  assert.match(app, /try \{ closeWebStorageModal\(\); \} catch \(_\) \{\}/);
  const closeBlock = app.slice(app.indexOf('function closeWebStorageModal'), app.indexOf('function webStorageSetError'));
  assert.match(closeBlock, /web-storage-connector.*replaceChildren/);
  assert.match(closeBlock, /web-storage-list.*replaceChildren/);
  assert.match(app, /e\.key==='Escape'.*web-storage-overlay.*closeWebStorageModal/);
  assert.match(app, /webStorage\.empty/);
});

test('web-storage helper cache is bypassed for fresh If-Range validation and range parsing is conservative', async () => {
  const { createWebStorageShareTools } = require('../lib/web-storage-share');
  let calls = 0;
  const fake = {
    async stat(_connector, rel) { calls += 1; return { name:'a.bin', path:rel, isDir:false, size:10, id:'id-1', modTime:`2026-08-18T12:00:0${calls}Z` }; },
    async list() { return []; },
  };
  const tools = createWebStorageShareTools({ storageConnectorService:fake, cacheMs:15000 });
  const share = { id:'s1', type:'web-storage', webStorage:{ connectorId:'c1', connectorName:'Cloud', connectorType:'webdav', remote:'cloud', root:'', path:'a.bin', isDir:false, sourceId:'id-1' } };
  const a = await tools.stat(share, '');
  const b = await tools.stat(share, '');
  assert.equal(calls, 1);
  assert.equal(a.modTime, b.modTime);
  const c = await tools.stat(share, '', { fresh:true });
  assert.equal(calls, 2);
  const tag = tools.etag(share, c, '');
  assert.ok(tag && tag.startsWith('"dx-cloud-'));
  assert.deepEqual(tools.parseRange({ headers:{ range:'bytes=2-5', 'if-range':tag } }, 10, tag), { start:2, end:5, status:206 });
  assert.deepEqual(tools.parseRange({ headers:{ range:'bytes=2-5', 'if-range':'"old"' } }, 10, tag), { start:0, end:9, status:200 });
  assert.equal(tools.parseRange({ headers:{ range:'bytes=0-1,4-5' } }, 10, tag).error, 'multi-range');
});

test('Windows ServerHost integrity manifest protects the web-storage backend and UI assets', () => {
  const host = read('windows-server-host/Program.cs');
  for (const file of ['lib/storage-connectors.js','lib/web-storage-share.js','lib/web-storage-writable.js','lib/server/public-pages.js','public/index.html','public/app.js','public/style.css']) {
    assert.match(host, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});


test('PWA host-share library renders web-storage links as cloud shares with normal download controls', () => {
  assert.match(pwaApp, /if \(s\.type === 'web-storage'\) bits\.push\('☁'\)/);
  assert.match(pwaApp, /s\.type === 'file' \|\| s\.type === 'folder' \|\| s\.type === 'web-storage'/);
  assert.match(pwaApp, /'web-storage':'shareStatsWebStorage'/);
  assert.match(pwaApp, /shareStatsWebStorage:'Stockage web'/);
  assert.match(pwaApp, /2026\.08\.25-pwa460/);
});

test('share config import accepts web-storage only when the frozen route still matches a configured connector', () => {
  const block = server.slice(server.indexOf("adminRouter.post('/shares/import'"), server.indexOf('// Resolves one host path', server.indexOf("adminRouter.post('/shares/import'")));
  assert.match(block, /\['file', 'folder', 'inbox', 'collab', 'web-storage'\]/);
  assert.match(block, /webStorageImportMeta\(rec,getStorageConnector/);
  assert.match(block, /rec\.allowZip=false/);
  assert.match(block, /delete rec\.hostPath/);
  assert.match(block, /delete rec\.items/);

  const { createWebStorageShareTools } = require('../lib/web-storage-share');
  const tools = createWebStorageShareTools({ storageConnectorService:{ async stat(){}, async list(){ return []; } } });
  const share = { type:'web-storage', name:'Report', webStorage:{ connectorId:'c1', connectorName:'Old', connectorType:'webdav', remote:'cloud', root:'base', path:'docs/report.pdf', isDir:false, sourceId:'id-1', sourceName:'report.pdf' } };
  const connector = { id:'c1', name:'Current', type:'webdav', remote:'cloud', root:'base' };
  assert.deepEqual(tools.importMeta(share, connector), { connectorId:'c1', connectorName:'Current', connectorType:'webdav', remote:'cloud', root:'base', path:'docs/report.pdf', isDir:false, sourceId:'id-1', sourceName:'report.pdf', readOnly:false });
  assert.equal(tools.importMeta(share, { ...connector, remote:'other' }), null);
  assert.equal(tools.importMeta(share, { ...connector, id:'c2' }), null);
});

test('cloud link cleanup clears hidden credentials and labels on logout', () => {
  const closeBlock = app.slice(app.indexOf('function closeWebStorageModal'), app.indexOf('function webStorageSetError'));
  for (const id of ['web-storage-password','web-storage-name','web-storage-note','web-storage-maxdl','web-storage-rate']) assert.match(closeBlock, new RegExp(id));
  assert.match(closeBlock, /\$\(id\)\.value=''/);
});

test('cloud links expose their remote relative path in authenticated detailed statistics', () => {
  const block = server.slice(server.indexOf('async function detailedShareStatsPayload'), server.indexOf("adminRouter.get('/shares/:id/visitor-test'"));
  assert.match(block, /s\.webStorage\?\(s\.webStorage\.path\|\|'\/'\)/);
});

test('cloud reactivation and visitor-test verify that the remote object still exists and has the expected kind', () => {
  const availability = server.slice(server.indexOf('async function shareReactivationAvailability'), server.indexOf('async function reactivateRevokedShare'));
  assert.match(availability, /sh\.webStorage/);
  assert.match(availability, /webStorageStat\(sh,'',\{fresh:true\}\)/);
  assert.match(availability, /!!st\.isDir===!!meta\.isDir/);
  const probe = server.slice(server.indexOf("adminRouter.get('/shares/:id/visitor-test'"), server.indexOf("adminRouter.get('/shares/:id/stats-detail'"));
  assert.match(probe, /sh\.webStorage\?await shareReactivationAvailability\(sh\)/);
});

test('PWA host-share API actually returns and manages web-storage links, not only their client-side card type', () => {
  const listStart = pwaRoutes.indexOf("app.get('/app/host/shares'");
  const listBlock = pwaRoutes.slice(listStart, pwaRoutes.indexOf("app.get('/app/host/shares/:token/stats-detail'", listStart));
  assert.match(listBlock, /s\.type === 'web-storage'/);
  const pwaPhotoService = read('lib/server/pwa-photo-service.js');
  const manageBlock = pwaPhotoService.slice(pwaPhotoService.indexOf('function pwaCanManageHostShare'), pwaPhotoService.indexOf('function pwaDlpPolicyPayload'));
  assert.match(manageBlock, /'web-storage'/);
  const rateStart = pwaRoutes.indexOf("app.post('/app/host/shares/:token/rate'");
  const rateBlock = pwaRoutes.slice(rateStart, pwaRoutes.indexOf("app.get('/app/host/shares'", rateStart));
  assert.match(rateBlock, /\['file','folder','web-storage'\]/);
});
