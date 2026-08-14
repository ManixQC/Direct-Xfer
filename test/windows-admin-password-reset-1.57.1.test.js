'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { parseHash, verifyPassword } = require('../lib/auth-utils');

const project = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(project, 'windows-launcher', 'Program.cs'), 'utf8');
const server = fs.readFileSync(path.join(project, 'server.js'), 'utf8');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close((err) => err ? reject(err) : resolve(p));
    });
  });
}

async function waitReady(port, token, child) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__dx_launcher/ready`, { headers:{'X-Direct-Xfer-Launcher-Token':token} });
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('server readiness timeout');
}

test('Windows tray exposes localized admin-password reset action', () => {
  assert.match(launcher, /ResetAdminPassword/);
  assert.match(launcher, /Réinitialiser le mot de passe admin…/);
  assert.match(launcher, /Reset admin password…/);
  assert.match(launcher, /Restablecer la contraseña de administrador…/);
  assert.match(launcher, /__dx_launcher\/reset-admin-password-ticket/);
  assert.match(launcher, /Uri\.EscapeDataString\(ticket\)/);
});

test('launcher password reset is loopback, short-lived, one-time and durable', { timeout: 25000 }, async (t) => {
  assert.match(server, /windowsLauncherLoopback/);
  assert.match(server, /windowsLauncherResetTickets\.clear\(\)/);
  assert.match(server, /clearSessionsOfAccount\(owner\.id\)/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-win-reset-'));
  const port = await freePort();
  const token = 'launcher-reset-' + Math.random().toString(36).slice(2);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: project,
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1', NO_COLOR: '1',
      DATA_DIR: path.join(root, 'data'), INBOX_DIR: path.join(root, 'inbox'),
      HOST_ROOT: root, IMAGES_DIR: path.join(root, 'images'),
      DX_WINDOWS_LAUNCHER_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (b) => { logs += String(b); });
  child.stderr.on('data', (b) => { logs += String(b); });
  t.after(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/__dx_launcher/shutdown`, { method:'POST', headers:{'X-Direct-Xfer-Launcher-Token':token} });
    } catch (_) {}
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 4000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(root, { recursive:true, force:true });
  });

  try {
    await waitReady(port, token, child);
  } catch (e) {
    throw new Error(`${e.message}\n${logs.slice(-5000)}`);
  }

  let r = await fetch(`http://127.0.0.1:${port}/__dx_launcher/reset-admin-password-ticket`, { method:'POST', headers:{'X-Direct-Xfer-Launcher-Token':'wrong'} });
  assert.equal(r.status, 404);

  r = await fetch(`http://127.0.0.1:${port}/__dx_launcher/reset-admin-password-ticket`, { method:'POST', headers:{'X-Direct-Xfer-Launcher-Token':token} });
  assert.equal(r.status, 200);
  const issued = await r.json();
  assert.equal(issued.ok, true);
  assert.match(issued.ticket, /^[A-Za-z0-9_-]{40,}$/);

  r = await fetch(`http://127.0.0.1:${port}/__dx_launcher/reset-admin-password?ticket=${encodeURIComponent(issued.ticket)}&lang=fr`);
  assert.equal(r.status, 200);
  const page = await r.text();
  assert.match(page, /Réinitialiser le mot de passe admin/);
  assert.doesNotMatch(page, new RegExp(token));

  const form = new URLSearchParams({ ticket:issued.ticket, lang:'fr', password:'NewPassword123!', confirm:'NewPassword123!' });
  r = await fetch(`http://127.0.0.1:${port}/__dx_launcher/reset-admin-password`, { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:form });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Mot de passe administrateur réinitialisé/);

  const state = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shares.json'), 'utf8'));
  const owner = state.meta.accounts.find((a) => a.role === 'owner');
  assert.ok(owner);
  assert.equal(owner.pwChanged, true);
  assert.equal(verifyPassword('NewPassword123!', parseHash(owner.ah)), true);

  r = await fetch(`http://127.0.0.1:${port}/__dx_launcher/reset-admin-password`, { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:form });
  assert.equal(r.status, 410, 'ticket must be one-time');
});
