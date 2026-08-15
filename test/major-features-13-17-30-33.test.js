'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const resume = fs.readFileSync(path.join(ROOT, 'public', 'download-resume.js'), 'utf8');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const { normalizeConnector, cleanRelativePath, remoteSpec, safeLocalTarget, secureLocalParent, publishImportNoClobber } = require('../lib/storage-connectors');
const { verify } = require('../scripts/verify-audit-proof');

test('feature 13 persists resumable downloads in IndexedDB and uses verified Range requests', () => {
  assert.match(resume, /indexedDB\.open\(DB_NAME, 1\)/);
  assert.match(resume, /Range:`bytes=\$\{start\}-\$\{end\}`/);
  assert.match(resume, /'X-Direct-Xfer-Resume-Id':task\.id/);
  assert.match(resume, /headers\['If-Range'\] = task\.etag/);
  assert.match(resume, /await saveChunk\(task\.id/);
  assert.match(server, /function mergeDownloadRanges\(/);
  assert.match(server, /downloadRangesComplete\(session\.ranges, total\)/);
  assert.match(server, /X-Direct-Xfer-Resumable/);
  assert.match(server, /resume-unavailable-one-time/);
  assert.match(server, /completeManagedDownload\(/);
  assert.match(server, /resumeScope:`pwa-inbox:\$\{s\.id\}`/);
  assert.match(resume, /showSaveFilePicker/);
});

test('feature 17 validates connector metadata and confines local/remote paths', () => {
  const connector = normalizeConnector({ name:'NAS', type:'sftp', remote:'office:', root:'Direct-Xfer/files', readOnly:true });
  assert.equal(connector.remote, 'office');
  assert.equal(connector.root, 'Direct-Xfer/files');
  assert.equal(connector.readOnly, true);
  assert.equal(remoteSpec(connector, 'folder/test.bin'), 'office:Direct-Xfer/files/folder/test.bin');
  assert.equal(cleanRelativePath('../secret'), null);
  assert.equal(cleanRelativePath('/absolute'), null);
  assert.throws(() => normalizeConnector({ name:'x', type:'ftp', remote:'r' }), /invalid-connector-type/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-connector-'));
  try {
    assert.equal(safeLocalTarget(root, 'in/a.bin'), path.join(root, 'in', 'a.bin'));
    assert.throws(() => safeLocalTarget(root, '../../escape'), /invalid-local-path/);
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});

test('feature 17 rejects symlink escapes and publishes concurrent imports without overwrite', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-connector-safe-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-connector-outside-'));
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
    await assert.rejects(secureLocalParent(root, path.join(root, 'escape', 'file.bin')), /unsafe-local-parent/);
    const temporary = path.join(root, 'transfer.tmp');
    const target = path.join(root, 'report.bin');
    fs.writeFileSync(temporary, 'new'); fs.writeFileSync(target, 'old');
    const published = await publishImportNoClobber(temporary, target);
    assert.equal(published, path.join(root, 'report (1).bin'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    assert.equal(fs.readFileSync(published, 'utf8'), 'new');
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
    fs.rmSync(outside, { recursive:true, force:true });
  }
});

test('feature 17 is fully wired through Docker, API and admin UI', () => {
  assert.match(dockerfile, /\brclone\b/);
  assert.match(dockerfile, /COPY lib \.\/lib/);
  for (const route of [
    "adminRouter.get('/storage/connectors'", "adminRouter.post('/storage/connectors'",
    "adminRouter.patch('/storage/connectors/:id'", "adminRouter.delete('/storage/connectors/:id'",
    "adminRouter.post('/storage/connectors/:id/import'", "adminRouter.post('/storage/connectors/:id/export'",
  ]) assert.ok(server.includes(route), route);
  for (const id of ['connector-name','connector-type','connector-remote','connector-import','connector-export','connector-jobs']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(admin, /async function refreshStorageConnectors\(/);
  assert.match(admin, /attrs:\{ value:connector\.id \}/);
  assert.match(server, /RCLONE_CONFIG[\s\S]{0,180}rclone\.conf/);
  assert.match(server, /beforePublish:clamavEnabled\(\)[\s\S]{0,300}scanFile\(temporary\)/);
});

test('feature 30 suspends the affected writable link and supports explicit recovery', () => {
  assert.match(server, /ransomwareSuspendLink:\s*true/);
  assert.match(server, /function ransomwareShareBlocks\(/);
  assert.match(server, /ransomwareShareBlocks\(\)\[affected\.id\]/);
  assert.match(server, /error:'security-link-suspended'/);
  assert.match(server, /links:Object\.values\(linkBlocks\)/);
  assert.match(html, /id="cfg-ransom-suspend-link"/);
  assert.match(admin, /ransomwareSuspendLink:/);
});

function proofPayload(proof) {
  return JSON.stringify([
    proof.proofVersion, proof.app, proof.appVersion, proof.exportedAt, proof.entryCount,
    proof.entriesSha256, proof.head.seq, proof.head.hash, proof.hmacKeyId || '', proof.publicKeyId,
  ]);
}

test('feature 33 produces an independently verifiable Ed25519 proof and detects tampering', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicPem = pair.publicKey.export({ type:'spki', format:'pem' }).toString();
  const publicKeyId = crypto.createHash('sha256').update(pair.publicKey.export({ type:'spki', format:'der' })).digest('hex');
  const entryHash = crypto.createHash('sha256').update('entry').digest('hex');
  const entries = [{ seq:1, at:1, action:'test', prevHash:'', hash:entryHash }];
  const digest = crypto.createHash('sha256').update(JSON.stringify(entries[0]) + '\n').digest('hex');
  const proof = { proofVersion:1, app:'Direct-Xfer', appVersion:'1.59.4', exportedAt:2, entryCount:1, entriesSha256:digest, head:{ seq:1, hash:entryHash }, publicKeyId, publicKey:publicPem, algorithm:'Ed25519', entries };
  proof.signature = crypto.sign(null, Buffer.from(proofPayload(proof)), pair.privateKey).toString('base64');
  assert.deepEqual(verify(proof, { publicKeyId }), { ok:true, reason:null, entries:1, keyId:publicKeyId });
  assert.equal(verify(proof, { publicKeyId:'0'.repeat(64) }).reason, 'untrusted-public-key');
  proof.entries[0].action = 'tampered';
  assert.equal(verify(proof).reason, 'entry-digest-mismatch');
  assert.match(server, /function buildAuditProof\(/);
  assert.match(server, /format === 'proof'|fmt === 'proof'/);
  assert.match(server, /error:'audit-integrity-failed'/);
  assert.match(html, /id="cfg-audit-proof"/);
});
