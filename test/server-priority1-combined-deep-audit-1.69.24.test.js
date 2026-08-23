'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHostPathService } = require('../lib/server/host-path-service');
const { mapLimit } = require('../lib/core-utils');
const { createTransferService } = require('../lib/server/transfer-service');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

test('priority 1 utilities no longer live in server.js', () => {
  const server = read('server.js');
  for (const name of ['withinRoot', 'resolveWithin', 'assertRealWithin', 'containerToHost', 'hostToContainer', 'mapLimit', 'readLogTail', 'readLogTailAsync']) {
    assert.doesNotMatch(server, new RegExp(`function\\s+${name}\\s*\\(`), `${name} should not be implemented in server.js`);
  }
  assert.match(server, /createHostPathService\(\{ fs, path, hostRoot:HOST_ROOT \}\)/);
  assert.match(server, /readLogTail:\s*\(\.\.\.args\)\s*=>\s*transferService\.readLogTail\(\.\.\.args\)/);
  assert.ok(server.split('\n').length < 1650, `server.js should stay focused on composition (${server.split('\n').length} lines)`);
  for (const stale of [
    'Export the currently filtered Images dashboard as CSV',
    'Server-Sent Events activity stream (owner/admin/auditor)',
    'Export the persistent transfer journal (transfers.log) as CSV or JSON',
  ]) assert.doesNotMatch(server, new RegExp(stale.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('host path service preserves traversal containment and host mapping', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-host-path-'));
  const root = path.join(temp, 'host');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(root, { recursive:true });
  fs.mkdirSync(outside, { recursive:true });
  fs.writeFileSync(path.join(root, 'inside.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside');
  try {
    const svc = createHostPathService({ fs, path, hostRoot:root });
    assert.equal(svc.withinRoot(root, root), true);
    assert.equal(svc.withinRoot(root, path.join(root, 'nested', 'file')), true);
    assert.equal(svc.withinRoot(root, outside), false);
    assert.equal(svc.resolveWithin(root, '../outside.txt'), path.join(root, 'outside.txt'));
    assert.equal(svc.resolveWithin(root, '/absolute-looking.txt'), path.join(root, 'absolute-looking.txt'));
    assert.equal(svc.hostToContainer('/folder/file.txt'), path.join(root, 'folder', 'file.txt'));
    assert.equal(svc.containerToHost(path.join(root, 'folder', 'file.txt')), '/folder/file.txt');
    assert.throws(() => svc.containerToHost(path.join(outside, 'outside.txt')), (error) => error && error.code === 'EPATH');
    const insidePath = path.join(root, 'inside.txt');
    // fs.realpath() canonicalizes Windows 8.3 aliases (for example RUNNER~1)
    // to their long-path form on GitHub-hosted runners. assertRealWithin() is
    // specified to return that canonical real path, so compare like-for-like.
    assert.equal(await svc.assertRealWithin(root, insidePath), await fs.promises.realpath(insidePath));

    const link = path.join(root, 'escape');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.diagnostic(`symlink containment sub-check skipped: ${error.code || error.message}`);
      return;
    }
    await assert.rejects(() => svc.assertRealWithin(root, path.join(link, 'outside.txt')), (error) => error && error.code === 'EPATH');
  } finally {
    fs.rmSync(temp, { recursive:true, force:true });
  }
});

test('mapLimit preserves result order and bounds concurrency', async () => {
  let active = 0;
  let peak = 0;
  const values = await mapLimit([20, 5, 15, 1, 8], 2, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return `${index}:${delay}`;
  });
  assert.equal(peak, 2);
  assert.deepEqual(values, ['0:20', '1:5', '2:15', '3:1', '4:8']);
  assert.deepEqual(await mapLimit([], 4, async () => 'never'), []);
});

test('transfer service owns bounded synchronous and asynchronous journal tail reads', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-transfer-tail-'));
  const logFile = path.join(temp, 'transfers.log');
  try {
    const content = 'discard-me\nkeep-one\nkeep-two\n';
    fs.writeFileSync(logFile, content);
    const svc = createTransferService({
      crypto, fs, LOG_FILE:logFile,
      getState:() => ({ history:[] }),
      getById:() => null,
    });
    const maxBytes = Buffer.byteLength('ard-me\nkeep-one\nkeep-two\n');
    assert.deepEqual(svc.readLogTail(maxBytes), ['keep-one', 'keep-two', '']);
    assert.deepEqual(await svc.readLogTailAsync(maxBytes), ['keep-one', 'keep-two', '']);
    const exactBoundary = Buffer.byteLength('keep-one\nkeep-two\n');
    assert.deepEqual(svc.readLogTail(exactBoundary), ['keep-one', 'keep-two', '']);
    assert.deepEqual(await svc.readLogTailAsync(exactBoundary), ['keep-one', 'keep-two', '']);
    assert.deepEqual(svc.readLogTail(0), ['']);

    fs.rmSync(logFile, { force:true });
    assert.deepEqual(svc.readLogTail(1024), []);
    assert.deepEqual(await svc.readLogTailAsync(1024), []);
  } finally {
    fs.rmSync(temp, { recursive:true, force:true });
  }
});

test('transfer journal async reader honors the injected fs descriptor implementation', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-transfer-fs-'));
  const logFile = path.join(temp, 'transfers.log');
  fs.writeFileSync(logFile, 'one\ntwo\n');
  let opens = 0;
  const injectedFs = Object.create(fs);
  injectedFs.open = (...args) => { opens += 1; return fs.open(...args); };
  injectedFs.close = (...args) => fs.close(...args);
  injectedFs.fstat = (...args) => fs.fstat(...args);
  injectedFs.read = (...args) => fs.read(...args);
  try {
    const svc = createTransferService({
      crypto, fs:injectedFs, LOG_FILE:logFile,
      getState:() => ({ history:[] }), getById:() => null,
    });
    assert.deepEqual(await svc.readLogTailAsync(1024), ['one', 'two', '']);
    assert.equal(opens, 1);
  } finally {
    fs.rmSync(temp, { recursive:true, force:true });
  }
});
