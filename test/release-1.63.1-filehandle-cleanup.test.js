'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openFd, closeFd, statFd, readFd } = require('../lib/fd-utils');

const ROOT = path.resolve(__dirname, '..');

function text(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('runtime code does not create garbage-collected fs.promises FileHandle objects', () => {
  const server = text('server.js');
  const content = text('lib/file-content-utils.js');
  assert.doesNotMatch(server, /\bfs\.promises\.open\s*\(/);
  assert.doesNotMatch(content, /\bfs\.promises\.open\s*\(/);
  assert.match(server, /fs\.createReadStream\(absPath, \{ highWaterMark: 64 \* 1024 \}\)/);
});

test('numeric descriptor helper reads, stats and explicitly closes a file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-fd-'));
  const file = path.join(dir, 'sample.bin');
  fs.writeFileSync(file, Buffer.from('direct-xfer-filehandle-cleanup'));
  let fd = null;
  try {
    fd = await openFd(file, 'r');
    const st = await statFd(fd);
    assert.equal(st.size, 30);
    const buf = Buffer.alloc(6);
    const { bytesRead } = await readFd(fd, buf, 0, buf.length, 7);
    assert.equal(bytesRead, 6);
    assert.equal(buf.toString('utf8'), 'xfer-f');
    await closeFd(fd);
    fd = null;
  } finally {
    if (fd !== null) await closeFd(fd).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
