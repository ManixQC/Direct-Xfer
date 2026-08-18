'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
const server = read('server.js');
const storageSource = read('lib/storage-connectors.js');
const pwa = read('pwa/admin-audit-connectors.js');
const theme = read('pwa/theme-init.js');
const sw = read('pwa/sw.js');
const { StorageConnectorService, safeLocalTarget } = require('../lib/storage-connectors');

test('PWA build pwa341 loads and precaches audit/connectors administration module', () => {
  for (const file of ['pwa/admin-advanced.js','pwa/app.js','pwa/index.html','pwa/sw.js','pwa/theme-init.js']) {
    assert.match(read(file), /pwa341|v=341/);
  }
  assert.match(theme, /admin-audit-connectors\.js\?v=341/);
  assert.match(sw, /admin-audit-connectors\.js\?v=341/);
  assert.match(server, /'\/admin-audit-connectors\.js'/);
  assert.doesNotMatch(theme + sw, /pwa321|v=321/);
});

test('signed audit viewer uses chain verification, Ed25519 self-verification and signed export', () => {
  assert.match(server, /adminRouter\.get\('\/audit\/signed-verify', requireAuditAccess/);
  assert.match(server, /buildAuditProof\(entries, integrity\)/);
  assert.match(server, /verifyAuditProofBundle\(proof\)/);
  assert.match(server, /timingSafeEqualStr\(String\(checked\.keyId\), String\(expectedKeyId\)\)/);
  assert.match(pwa, /\/api\/audit\?limit=200/);
  assert.match(pwa, /\/api\/audit\/signed-verify/);
  assert.match(pwa, /\/api\/audit\/export\?format=proof/);
  assert.match(pwa, /auditSigOk/);
});

test('storage PWA covers connector CRUD/test, remote browser, imports, job polling and cancellation', () => {
  for (const pattern of [
    /\/api\/storage\/connectors'/,
    /\/api\/storage\/connectors\/.*\/test/,
    /\/api\/storage\/connectors\/.*\/list\?path=/,
    /\/api\/storage\/connectors\/.*\/import/,
    /\/api\/storage\/jobs\/.*\/cancel/,
  ]) assert.match(pwa, pattern);
  assert.match(pwa, /server-to-server import/i);
  assert.match(pwa, /Les mots de passe, jetons OAuth et clés privées ne sont jamais envoyés à la PWA/);
  assert.match(pwa, /setTimeout\(function\(\)\{loadConnectors\(true\);\},3000\)/);
});

test('connector jobs register their controller before orphan pruning', () => {
  const setAt = server.indexOf('activeConnectorJobs.set(job.id, controller);');
  const unshiftAt = server.indexOf('jobs.unshift(job); pruneConnectorJobs();', setAt);
  assert.ok(setAt >= 0 && unshiftAt > setAt);
  assert.match(server, /activeConnectorJobs\.delete\(job\.id\);\n\s*throw Object\.assign\(new Error\('write-error'\)/);
});

test('connector capability response hides rclone config path and exposes supported types', () => {
  assert.match(server, /const publicCapabilities = \{/);
  assert.match(server, /types:Array\.from\(CONNECTOR_TYPES\)/);
  const block = server.slice(server.indexOf("adminRouter.get('/storage/connectors'"), server.indexOf("adminRouter.post('/storage/connectors'"));
  assert.doesNotMatch(block, /configPath/);
});

test('connector runner executes a JavaScript rclone wrapper portably without a shell', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-rclone-js-wrapper-'));
  const wrapper = path.join(temp, 'fake-rclone.js');
  fs.writeFileSync(wrapper, "'use strict';\nif(process.argv[2]==='version'){console.log('rclone vJS-WRAPPER');process.exit(0);}process.exit(2);\n");
  const service = new StorageConnectorService({ bin:wrapper, configPath:path.join(temp, 'rclone.conf'), importRoot:path.join(temp, 'imports') });
  try {
    const result = await service.capabilities();
    assert.equal(result.available, true, JSON.stringify(result));
    assert.equal(result.version, 'rclone vJS-WRAPPER');
    assert.match(storageSource, /avoiding shell:true/);
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});

test('remote browser returns connector-root-relative paths inside nested folders', async () => {
  const service = new StorageConnectorService({ bin:'unused', configPath:path.join(os.tmpdir(), 'unused-rclone.conf'), importRoot:path.join(os.tmpdir(), 'unused-import') });
  service.run = async (args) => {
    assert.equal(args[0], 'lsjson');
    assert.equal(args[1], 'fake:docs');
    return { stdout:JSON.stringify([{ Name:'nested.txt', Path:'nested.txt', IsDir:false, Size:12 }]), stderr:'' };
  };
  const rows = await service.list({ remote:'fake', root:'' }, 'docs');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, 'docs/nested.txt');
  assert.match(storageSource, /Return a connector-root-relative path/);
});



test('deep audit hardening freezes queued connector routing and clears privileged PWA state', () => {
  assert.match(server, /const jobConnector = Object\.freeze\(\{ \.\.\.connector \}\);/);
  assert.match(server, /storageConnectorService\.importFile\(jobConnector/);
  assert.match(server, /storageConnectorService\.exportFile\(jobConnector/);
  assert.match(server, /if \(controller\.signal\.aborted\) \{\s*job\.status = 'cancelled'/);
  assert.match(pwa, /function clearPrivilegedData\(\)/);
  assert.match(pwa, /if\(r\.status===401\|\|r\.status===403\)\{clearSession\(\);clearPrivilegedData\(\);\}/);
  assert.match(pwa, /if\(hasActive&&active\(\)\)jobsTimer=setTimeout/);
});

test('imports cannot target Direct-Xfer internal .dx namespaces', () => {
  const rootDir = path.join(os.tmpdir(), 'dx-safe-local-root');
  assert.throws(() => safeLocalTarget(rootDir, '.dxconnector-import-staging/payload'), /invalid-local-path/);
  assert.throws(() => safeLocalTarget(rootDir, 'folder/.dxhidden/file.txt'), /invalid-local-path/);
  assert.equal(safeLocalTarget(rootDir, 'folder/file.txt'), path.resolve(rootDir, 'folder/file.txt'));
});

test('staging root rejects a symlinked import root where supported', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-import-root-symlink-'));
  const real = path.join(temp, 'real');
  const linked = path.join(temp, 'linked');
  fs.mkdirSync(real, { recursive:true });
  try { fs.symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (_) { fs.rmSync(temp, { recursive:true, force:true }); return t.skip('symlinks unavailable'); }
  const service = new StorageConnectorService({ bin:'unused', configPath:path.join(temp, 'rclone.conf'), importRoot:linked });
  await assert.rejects(service.ensureStagingRoot(), /unsafe-import-root/);
  fs.rmSync(temp, { recursive:true, force:true });
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(url, child, logs, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${logs.join('')}`);
    try { const r = await fetch(url); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`server did not become ready: ${logs.join('')}`);
}

function cookieHeader(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return values.map((v) => String(v).split(';', 1)[0]).join('; ');
}

async function waitJob(base, cookie, connectorId, jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(base + '/api/storage/connectors', { headers:{ Cookie:cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    const job = (body.jobs || []).find((x) => x.id === jobId);
    if (job && ['completed','failed','cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('connector job did not finish');
}

test('real server verifies signed audit and imports a nested remote file server-to-server', { timeout:35000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-admin-151921-real-'));
  const hostDir = path.join(temp, 'host');
  const dataDir = path.join(temp, 'data');
  const images = path.join(temp, 'images');
  const inbox = path.join(temp, 'inbox');
  const fakeRclone = path.join(temp, 'fake-rclone.js');
  fs.mkdirSync(hostDir, { recursive:true });
  fs.writeFileSync(fakeRclone, `#!/usr/bin/env node\n'use strict';\nconst fs=require('fs'),path=require('path');\nconst a=process.argv.slice(2),cmd=a[0];\nif(cmd==='version'){console.log('rclone vFAKE-1.0');process.exit(0);}\nif(cmd==='listremotes'){console.log('fake:');process.exit(0);}\nif(cmd==='lsjson'){const spec=String(a[1]||'');if(a.includes('--stat')){console.log(JSON.stringify({Name:'',Path:'',IsDir:true}));process.exit(0);}const rel=(spec.split(':').slice(1).join(':')||'').replace(/^\\/+|\\/+$/g,'');if(rel==='docs')console.log(JSON.stringify([{Name:'nested.txt',Path:'nested.txt',IsDir:false,Size:19}]));else console.log(JSON.stringify([{Name:'docs',Path:'docs',IsDir:true,Size:0},{Name:'root.txt',Path:'root.txt',IsDir:false,Size:9}]));process.exit(0);}\nif(cmd==='copyto'){const src=String(a[1]||''),dst=String(a[2]||'');fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,'REMOTE:'+src);process.exit(0);}\nconsole.error('unsupported '+cmd);process.exit(2);\n`);
  if (process.platform !== 'win32') fs.chmodSync(fakeRclone, 0o755);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd:root,
    env:{
      ...process.env, PORT:String(port), HOST_ROOT:hostDir, DATA_DIR:dataDir, IMAGES_DIR:images, INBOX_DIR:inbox,
      ADMIN_USERNAME:'admin', ADMIN_PASSWORD:'AuditPass123!', UPDATE_CHECK:'false', PUBLIC_URL:'',
      RCLONE_BIN:fakeRclone, RCLONE_CONFIG:path.join(temp, 'rclone.conf'),
    },
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  try {
    await waitFor(base + '/healthz', child, logs);
    const asset = await fetch(base + '/app/admin-audit-connectors.js?v=341');
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /server-to-server import/);

    const anon = await fetch(base + '/api/audit/signed-verify');
    assert.equal(anon.status, 401);

    const login = await fetch(base + '/api/login', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ username:'admin', password:'AuditPass123!' }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    const cookie = cookieHeader(login);
    const auth = { Cookie:cookie };
    const mutate = { Cookie:cookie, 'X-CSRF-Token':loginBody.csrf, Origin:base, 'Content-Type':'application/json' };

    const signed = await fetch(base + '/api/audit/signed-verify', { headers:auth });
    const signedBody = await signed.json();
    assert.equal(signed.status, 200, JSON.stringify(signedBody));
    assert.equal(signedBody.ok, true);
    assert.equal(signedBody.signature.ok, true);
    assert.equal(signedBody.signature.algorithm, 'Ed25519');
    assert.match(signedBody.signature.publicKeyId, /^[a-f0-9]{64}$/);

    let listing = await fetch(base + '/api/storage/connectors', { headers:auth });
    let listingBody = await listing.json();
    assert.equal(listing.status, 200, JSON.stringify(listingBody));
    assert.equal(listingBody.capabilities.available, true);
    assert.equal(Object.hasOwn(listingBody.capabilities, 'configPath'), false);
    assert.ok(listingBody.remotes.includes('fake'));
    assert.ok(listingBody.types.includes('sftp'));

    const created = await fetch(base + '/api/storage/connectors', {
      method:'POST', headers:mutate,
      body:JSON.stringify({ name:'Fake NAS', type:'sftp', remote:'fake', root:'', readOnly:true }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201, JSON.stringify(createdBody));
    const id = createdBody.connector.id;

    const rootList = await fetch(base + `/api/storage/connectors/${encodeURIComponent(id)}/list?path=`, { headers:auth }).then((r) => r.json());
    assert.ok(rootList.entries.some((x) => x.path === 'docs' && x.isDir));
    const nestedList = await fetch(base + `/api/storage/connectors/${encodeURIComponent(id)}/list?path=docs`, { headers:auth }).then((r) => r.json());
    assert.ok(nestedList.entries.some((x) => x.path === 'docs/nested.txt' && !x.isDir));

    const queued = await fetch(base + `/api/storage/connectors/${encodeURIComponent(id)}/import`, {
      method:'POST', headers:mutate,
      body:JSON.stringify({ remotePath:'docs/nested.txt', target:'from-fake/nested.txt' }),
    });
    const queuedBody = await queued.json();
    assert.equal(queued.status, 202, JSON.stringify(queuedBody));
    assert.equal(queuedBody.job.status, 'queued');
    assert.notEqual(queuedBody.job.error, 'server-restarted');

    const job = await waitJob(base, cookie, id, queuedBody.job.id);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.equal(job.error, null);
    const imported = path.join(inbox, 'Imports', 'from-fake', 'nested.txt');
    assert.equal(fs.readFileSync(imported, 'utf8'), 'REMOTE:fake:docs/nested.txt');
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(temp, { recursive:true, force:true });
  }
});
