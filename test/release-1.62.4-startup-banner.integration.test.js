'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startupLog(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-banner-'));
  for (const dir of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'shares.json'), JSON.stringify({
    version: 1,
    shares: [], trash: [],
    settings: { updateCheck: false, ...settings },
    history: [], photoHistory: [], stats: {}, meta: {}, audit: [], ipNames: {}, undoLog: [], activityLog: [],
  }));
  const port = await freePort();
  const publicUrl = 'https://files.example.test';
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      ADMIN_PASSWORD: 'Banner-test-2026!',
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      PUBLIC_URL: publicUrl, UPDATE_CHECK: 'false', SEARCH_OCR_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('Public IMG URL') && Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.match(output, /Public IMG URL/, output);
    return { output, publicUrl };
  } finally {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('startup title box is aligned and Images public URL uses imageBase', async () => {
  const { output } = await startupLog({ linkBase: 'https://files.example.test', imageBase: 'https://img.example.test' });
  const lines = output.split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => line.includes('Direct-Xfer — HTTP(S) file sharing'));
  assert.ok(titleIndex > 0, output);
  const box = lines.slice(titleIndex - 1, titleIndex + 2);
  assert.equal(box.length, 3);
  assert.equal(box[0].length, box[1].length, box.join('\n'));
  assert.equal(box[1].length, box[2].length, box.join('\n'));
  assert.match(box[0], /^  ┌─+┐$/);
  assert.match(box[1], /^  │ +Direct-Xfer — HTTP\(S\) file sharing +│$/);
  assert.match(box[2], /^  └─+┘$/);
  const publicIndex = lines.findIndex((line) => line.includes('• Public URL'));
  const imageIndex = lines.findIndex((line) => line.includes('• Public IMG URL'));
  assert.equal(imageIndex, publicIndex + 1, output);
  assert.match(lines[imageIndex], /https:\/\/img\.example\.test  \(Images\)$/);
});

test('startup Images URL falls back to the main public base when no imageBase is configured', async () => {
  const { output, publicUrl } = await startupLog({ linkBase: '', imageBase: '' });
  const line = output.split(/\r?\n/).find((entry) => entry.includes('• Public IMG URL')) || '';
  assert.ok(line.includes(publicUrl), output);
  assert.match(line, /\(same public base\)$/);
});
