'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const admin = read('pwa/admin-advanced.js');
const healthSource = read('lib/pwa-admin-health-route.js');
const server = read('server.js') + '\n' + read('lib/server/pwa-application.js') + '\n' + read('lib/server/admin-share-routes.js') + '\n' + read('lib/server/admin-settings-routes.js') + '\n' + read('lib/server/settings-service.js') + '\n' + read('lib/server/admin-dashboard-routes.js');
const adminRouterSource = read('lib/server/admin-router.js');
const core = read('lib/core-utils.js');
const theme = read('pwa/theme-init.js');
const sw = read('pwa/sw.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-health-history-'));
process.env.DATA_DIR = dataDir;
const now = Date.now();
const points = [];
for (let i = 0; i < 30 * 24 * 12; i += 1) {
  const at = now - (30 * 24 * 12 - 1 - i) * 5 * 60 * 1000;
  points.push({ at, cpu: 20 + (i % 50), ram: 45 + (i % 20), disk: 60, load: 15 + (i % 30), processRss: 100000000 + i });
}
fs.writeFileSync(path.join(dataDir, 'pwa-admin-health-history.json'), JSON.stringify({ version:1, points }));
const health = require('../lib/pwa-admin-health-route');

test.after(() => {
  health.stopHistorySampler();
  fs.rmSync(dataDir, { recursive:true, force:true });
});

test('PWA cache build is synchronized to pwa468', () => {
  assert.match(theme, /2026\.08\.25-pwa468/);
  assert.match(theme, /admin-advanced\.js\?v=449/);
  assert.match(sw, /2026\.08\.25-pwa468/);
  assert.match(sw, /admin-advanced\.js\?v=449/);
  assert.match(read('pwa/app.js'), /2026\.08\.25-pwa468/);
  assert.match(read('pwa/login.js'), /v=449/);
  assert.match(read('pwa/index.html'), /pwa468/);
  for (const file of ['pwa/admin-advanced.js','pwa/app.js','pwa/index.html','pwa/login.js','pwa/sw.js','pwa/theme-init.js']) {
    assert.doesNotMatch(read(file), /pwa320|v=320/);
  }
});

test('health routes are attached directly to the authenticated admin router', () => {
  assert.match(server, /attachHealthRoute\(adminRouter\)/);
  assert.doesNotMatch(core, /pwa-admin-health-route/);
  assert.doesNotMatch(healthSource, /express\.application|__dxPwaAdminHealthHook|proto\.use/);
  assert.match(healthSource, /role === 'owner' \|\| role === 'admin'/);
  assert.match(adminRouterSource, /adminRouter\.use\(requireAuth\)/);
  assert.match(server, /password-change-required/);
});

test('performance history retains exactly 30 days, clamps corrupted metrics and returns bounded buckets', () => {
  assert.equal(health.HISTORY_SAMPLE_MS, 5 * 60 * 1000);
  assert.equal(health.HISTORY_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(health.HISTORY_FILE_MAX_BYTES, 4 * 1024 * 1024);
  assert.deepEqual(health.normalizeHistoryPoint({ at:now, cpu:-2, ram:300, disk:120, load:5000, processRss:-1 }), {
    at:now, cpu:0, ram:100, disk:100, load:1000, processRss:0,
  });
  const h24 = health.bucketHealthHistory('24h', now);
  const h7 = health.bucketHealthHistory('7d', now);
  const h30 = health.bucketHealthHistory('30d', now);
  assert.equal(h24.bucketMs, 5 * 60 * 1000);
  assert.equal(h7.bucketMs, 30 * 60 * 1000);
  assert.equal(h30.bucketMs, 2 * 60 * 60 * 1000);
  assert.ok(h24.points.length <= 289 && h24.points.length >= 280);
  assert.ok(h7.points.length <= 337 && h7.points.length >= 330);
  assert.ok(h30.points.length <= 361 && h30.points.length >= 350);
  assert.ok(h30.points.every((p) => Number.isFinite(p.ram) && Number.isFinite(p.disk)));
  assert.match(healthSource, /lstatSync\(file\)/);
  assert.match(healthSource, /st\.isSymbolicLink\(\)/);
  assert.match(healthSource, /history file has an invalid size/);
  assert.match(healthSource, /\.previous/);
});

test('oversized persisted performance history is rejected before JSON parsing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-health-oversize-'));
  try {
    fs.writeFileSync(path.join(dir, 'pwa-admin-health-history.json'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    const script = `process.env.DATA_DIR=${JSON.stringify(dir)};const h=require(${JSON.stringify(path.join(root, 'lib/pwa-admin-health-route.js'))});const rows=h.loadHealthHistory();if(rows.length!==0)process.exit(3);`;
    execFileSync(process.execPath, ['-e', script], { stdio:['ignore','pipe','pipe'] });
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('advanced PWA hardens history races, proxy/TLS diagnostics and Local CA verification', () => {
  assert.match(admin, /\/api\/pwa-admin-health\/history\?range=/);
  assert.match(admin, /range!==historyRange/);
  assert.match(admin, /historySeq/);
  assert.match(admin, /row\.at-minAt/); // chart x-axis uses real timestamps, not array indexes
  assert.match(admin, /p&&p\.samples/); // summary counts underlying samples, not display buckets
  assert.match(admin, /\/api\/diagnostics\/run/);
  assert.match(admin, /\/api\/network\/proxy-check/);
  assert.match(admin, /fetchJson\('\/api\/network\/proxy-check',8000\)\.catch/); // proxy detail failure does not erase TLS result
  assert.match(admin, /\/api\/diagnostics\/fix/);
  assert.match(admin, /tlsLocalCaFingerprint/);
  assert.match(admin, /\/api\/tls\/local-ca\.cer/);
  assert.match(admin, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(admin, /X-Direct-Xfer-CA-SHA256/);
  assert.match(admin, /expected\.length!==64\|\|header\.length!==64/);
  assert.match(admin, /bytes\.byteLength<64\|\|bytes\.byteLength>2\*1024\*1024/);
  assert.match(admin, /local-ca-download-requires-local-or-https/);
  assert.match(admin, /AbortController/);
  assert.match(admin, /diagnosticSeq/);
  assert.match(admin, /caSeq/);
  assert.match(admin, /emergencySeq/);
});

test('Local CA SHA-256 has a pure-JS fallback for HTTP LAN bootstrap', () => {
  const marker = 'function sha256FallbackHex';
  const start = admin.indexOf(marker);
  assert.ok(start >= 0);
  const open = admin.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < admin.length; i += 1) {
    if (admin[i] === '{') depth += 1;
    else if (admin[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > open);
  const fn = vm.runInNewContext('(' + admin.slice(start, end) + ')');
  const digest = fn(new TextEncoder().encode('abc'));
  assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(admin, /return sha256FallbackHex\(bytes\)/);
});

test('global pause includes scheduled links and resume only touches panic-paused links', () => {
  assert.match(server, /adminRouter\.post\('\/shares\/pause-all', requireFullAdmin/);
  assert.match(server, /!isActive\(s, now\) && !isScheduled\(s, now\)/);
  assert.match(server, /s\.disabled = true; s\.panicPaused = true/);
  assert.match(server, /s && s\.disabled && s\.panicPaused/);
  assert.match(admin, /\/api\/shares\/pause-all/);
  assert.match(admin, /\/api\/shares\/resume-all/);
  assert.match(admin, /X-CSRF-Token/);
  assert.match(admin, /actifs ou planifiés/);
});

test('advanced-admin script is a public static PWA asset so first service-worker install can cache it', () => {
  assert.match(server, /'\/admin-advanced\.js'/);
  assert.match(sw, /'\/app\/admin-advanced\.js\?v=449'/);
});

test('lite settings query actually omits the large logo payload', () => {
  assert.match(server, /settingsForClient\(req, String\(req\.query && req\.query\.lite \|\| ''\) === '1'\)/);
  assert.match(server, /if \(lite\) delete s\.publicLogo/);
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
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch (_) {}
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

test('real server keeps new endpoints protected, serves PWA asset pre-login, and panic-pauses a scheduled share', { timeout:30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-admin-37-real-'));
  const hostDir = path.join(temp, 'host');
  const runtimeData = path.join(temp, 'data');
  const images = path.join(temp, 'images');
  const inbox = path.join(temp, 'inbox');
  fs.mkdirSync(hostDir, { recursive:true });
  fs.writeFileSync(path.join(hostDir, 'sample.txt'), 'scheduled audit share');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd:root,
    env:{
      ...process.env,
      PORT:String(port),
      HOST_ROOT:hostDir,
      DATA_DIR:runtimeData,
      IMAGES_DIR:images,
      INBOX_DIR:inbox,
      ADMIN_USERNAME:'admin',
      ADMIN_PASSWORD:'AuditPass123!',
      UPDATE_CHECK:'false',
      PUBLIC_URL:'',
    },
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  try {
    await waitFor(base + '/healthz', child, logs);

    const publicAsset = await fetch(base + '/app/admin-advanced.js?v=449');
    assert.equal(publicAsset.status, 200);
    assert.match(await publicAsset.text(), /pwa468/);

    const anonHealth = await fetch(base + '/api/pwa-admin-health');
    assert.equal(anonHealth.status, 401);
    const anonHistory = await fetch(base + '/api/pwa-admin-health/history?range=24h');
    assert.equal(anonHistory.status, 401);

    const login = await fetch(base + '/api/login', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ username:'admin', password:'AuditPass123!' }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.equal(loginBody.role, 'owner');
    assert.equal(loginBody.mustChangePassword, false);
    const cookie = cookieHeader(login);
    assert.ok(cookie.includes('sid='));
    const headers = { Cookie:cookie, 'X-CSRF-Token':loginBody.csrf, Origin:base, 'Content-Type':'application/json' };

    for (const endpoint of ['/api/pwa-admin-health','/api/pwa-admin-health/history?range=30d','/api/network/proxy-check']) {
      const r = await fetch(base + endpoint, { headers:{ Cookie:cookie } });
      assert.equal(r.status, 200, endpoint);
      assert.match(String(r.headers.get('cache-control') || ''), /no-store/);
    }

    const diagnostics = await fetch(base + '/api/diagnostics/run', { method:'POST', headers, body:'{}' });
    assert.equal(diagnostics.status, 200);
    const diagnosticsBody = await diagnostics.json();
    assert.ok(diagnosticsBody.checks.some((c) => c.id === 'reverse-proxy'));
    assert.ok(diagnosticsBody.checks.some((c) => c.id === 'tls-certificate'));

    const liteSettings = await fetch(base + '/api/settings?lite=1', { headers:{ Cookie:cookie } });
    assert.equal(liteSettings.status, 200);
    const liteSettingsBody = await liteSettings.json();
    assert.equal(Object.prototype.hasOwnProperty.call(liteSettingsBody, 'publicLogo'), false);

    const create = await fetch(base + '/api/shares', {
      method:'POST', headers,
      body:JSON.stringify({ path:'/sample.txt', startsAt:Date.now() + 60 * 60 * 1000 }),
    });
    const createText = await create.text();
    assert.equal(create.status, 201, createText);
    const created = JSON.parse(createText);
    assert.ok(created.share && created.share.id);
    assert.equal(created.share.scheduled, true);
    assert.equal(created.share.disabled, false);

    const paused = await fetch(base + '/api/shares/pause-all', { method:'POST', headers, body:'{}' });
    assert.equal(paused.status, 200);
    const pausedBody = await paused.json();
    assert.ok(pausedBody.paused >= 1);

    let listing = await fetch(base + '/api/shares', { headers:{ Cookie:cookie } }).then((r) => r.json());
    let share = listing.shares.find((s) => s.id === created.share.id);
    assert.ok(share);
    assert.equal(share.disabled, true);
    assert.equal(share.active, false);

    const resumed = await fetch(base + '/api/shares/resume-all', { method:'POST', headers, body:'{}' });
    assert.equal(resumed.status, 200);
    const resumedBody = await resumed.json();
    assert.ok(resumedBody.resumed >= 1);

    listing = await fetch(base + '/api/shares', { headers:{ Cookie:cookie } }).then((r) => r.json());
    share = listing.shares.find((s) => s.id === created.share.id);
    assert.ok(share);
    assert.equal(share.disabled, false);
    assert.equal(share.scheduled, true);
    assert.equal(share.active, false);
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
