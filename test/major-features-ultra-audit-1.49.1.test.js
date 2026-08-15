'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const server = read('server.js');
const resume = read('public/download-resume.js');
const pwa = read('pwa/app.js');
const admin = read('public/app.js');
const connectorSource = read('lib/storage-connectors.js');
const verifier = read('scripts/verify-audit-proof.js');
const {
  StorageConnectorService,
  cleanRelativePath,
  normalizeConnector,
} = require('../lib/storage-connectors');

test('1.51.2 metadata and PWA resources are synchronized', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.59.5');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(pwa, /APP_VERSION = '1\.59\.5'/);
  assert.match(pwa, /APP_BUILD = '2026\.08\.14-pwa284'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa284'/);
  assert.match(read('pwa/index.html'), /download-resume\.js\?v=268/);
});

test('resumable downloads fail closed on blocked IndexedDB and validate every range', () => {
  assert.match(resume, /req\.onblocked = \(\) =>/);
  assert.match(resume, /indexeddb-timeout/);
  assert.match(resume, /invalid-content-range/);
  assert.match(resume, /resume-id-mismatch/);
  assert.match(resume, /response\.body\.cancel/);
  assert.match(resume, /resume-already-complete/);
  assert.match(resume, /DirectXferDownloads = Object\.freeze\(\{ clearAll:clearAllTasks \}\)/);
  assert.match(pwa, /window\.DirectXferDownloads\.clearAll\(\)/);
});

test('resumable tasks use a renewable cross-tab lease', () => {
  assert.match(resume, /const LEASE_MS = 45000/);
  assert.match(resume, /function claimTask\(id\)/);
  assert.match(resume, /function renewTaskLease\(id\)/);
  assert.match(resume, /leaseOwner !== instanceId/);
  assert.match(resume, /leaseLost = true/);
});

test('server-side resume accounting rejects replay and bare Range quota bypass', () => {
  assert.match(server, /session && session\.finalized\) return \{ id, error:'resume-already-complete' \}/);
  assert.match(server, /if \(resumeId\) return false; \/\/ completeManagedDownload commits it exactly once/);
  assert.doesNotMatch(server.match(/function ipDownloadQuotaBlocked[\s\S]*?\n\}/)?.[0] || '', /rangeStart/);
  assert.match(server, /req\.method === 'GET'[\s\S]{0,180}getDownloadResumeSession/);
  assert.match(server, /commitManagedIpDownload\(getById\(transferMeta\.shareId\), session\.quotaIp\)/);
  assert.match(server, /stat\.ctimeMs/);
});

test('connector paths reject controls and invalid rclone list rows', async () => {
  assert.equal(cleanRelativePath('folder/file.txt'), 'folder/file.txt');
  assert.equal(cleanRelativePath('folder\nfile.txt'), null);
  const service = new StorageConnectorService({ importRoot:os.tmpdir() });
  service.run = async () => ({ stdout:JSON.stringify([
    { Name:'ok.txt', Path:'safe/ok.txt', Size:4, IsDir:false },
    { Name:'escape', Path:'../escape', Size:1, IsDir:false },
    { Name:'bad\nname', Path:'safe/bad', Size:1, IsDir:false },
  ]) });
  const rows = await service.list(normalizeConnector({ name:'test', type:'sftp', remote:'remote' }), '');
  assert.deepEqual(rows.map((row) => row.path), ['safe/ok.txt']);
  assert.match(server, /segments\.some\(\(segment\) => segment\.startsWith\('\.dx'\)\)/);
  assert.match(connectorSource, /child\.kill\('SIGKILL'\)/);
  assert.match(server, /CONNECTOR_PROBE_CACHE_MS = 15000/);
  assert.match(admin, /connector-export'\)\.disabled = !selected \|\| !!selected\.readOnly/);
});

test('connector imports use isolated staging and stale payloads are removable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-connector-audit-'));
  try {
    const service = new StorageConnectorService({ importRoot:root });
    service.run = async (args) => { fs.writeFileSync(args[2], 'payload'); return { stdout:'', stderr:'' }; };
    const connector = normalizeConnector({ name:'test', type:'sftp', remote:'remote' });
    const result = await service.importFile(connector, 'source.bin', 'nested/target.bin');
    assert.equal(fs.readFileSync(result.target, 'utf8'), 'payload');
    assert.deepEqual(fs.readdirSync(service.stagingRoot()), []);
    const orphan = path.join(service.stagingRoot(), 'job-aaaaaaaaaaaa');
    fs.mkdirSync(orphan); fs.writeFileSync(path.join(orphan, 'payload'), 'old');
    assert.equal(await service.cleanupStaleImports(), 1);
    assert.equal(fs.existsSync(orphan), false);
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});

test('rclone child processes do not inherit Direct-Xfer secrets', () => {
  const names = ['ADMIN_PASSWORD','DATA_KEY','AUDIT_HMAC_KEY','AUDIT_SIGNING_PRIVATE_KEY','TLS_KEY','WEBHOOK_URL','SMTP_URL','SMTP_PASS','VAPID_PRIVATE_KEY','FUTURE_DIRECT_XFER_SECRET'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    names.forEach((name) => { process.env[name] = 'secret'; });
    const env = new StorageConnectorService({ configPath:'/tmp/rclone.conf' }).commandEnv();
    names.forEach((name) => assert.equal(env[name], undefined));
    assert.equal(env.RCLONE_CONFIG, '/tmp/rclone.conf');
    assert.equal(env.RCLONE_ASK_PASSWORD, 'false');
  } finally {
    names.forEach((name) => { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  }
});

test('ransomware isolation, audit rollback and proof trust are enforced', () => {
  assert.match(server, /const event = \{ at: now, kind, shareId/);
  assert.match(server, /shareDeletes60 >= deleteThreshold \? \[shareId\] : \[\]/);
  assert.match(server, /rejectSuspendedUploadFinalize/);
  assert.match(server, /fs\.truncateSync\(AUDIT_CHAIN_FILE, originalSize\)/);
  assert.match(server, /append refused while journal integrity is invalid/);
  assert.match(server, /durableAuditCreateSync\(AUDIT_SIGNING_PRIVATE_FILE/);
  assert.match(verifier, /a trusted --key-id or --public-key is required/);
  assert.match(verifier, /--allow-embedded-key/);
});
