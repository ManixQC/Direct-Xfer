'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('pwa/app.js');
const sw = read('pwa/sw.js');
const mobile = read('pwa/mobile-intelligence.js');
const index = read('pwa/index.html');
const server = read('server.js') + '\n' + read('lib/server/pwa-application.js');

function manifest(file) { return JSON.parse(read(file)); }

test('pwa461 loads and precaches the mobile intelligence module as a public shell asset', () => {
  for (const file of ['pwa/app.js','pwa/index.html','pwa/sw.js','pwa/theme-init.js','pwa/admin-advanced.js']) {
    assert.match(read(file), /pwa461|v=444/);
  }
  assert.match(index, /mobile-intelligence\.js\?v=444/);
  assert.match(sw, /\/app\/mobile-intelligence\.js\?v=444/);
  assert.match(server, /'\/mobile-intelligence\.js'/);
  assert.doesNotMatch(index + sw, /pwa323|v=323/);
});

test('active transfer notification carries aggregate progress, rate and ETA without filenames', () => {
  assert.match(app, /TRANSFER_PROGRESS/);
  assert.match(app, /postTransferNotification/);
  assert.match(app, /liveEtaSec/);
  assert.match(app, /persistent-transfer-notification/);
  assert.match(sw, /showActiveTransferNotification/);
  assert.match(sw, /requireInteraction:true/);
  assert.match(sw, /var pct=total>0\?Math\.max\(0,Math\.min\(100,Math\.round\(\(sent\/total\)\*100\)\)/);
  assert.match(sw, /dx-transfer-active/);
  const fn = sw.slice(sw.indexOf('async function showActiveTransferNotification'), sw.indexOf('async function', sw.indexOf('async function showActiveTransferNotification') + 20));
  assert.doesNotMatch(fn, /filename|fileName|data\.name/);
});

test('ETA estimator uses a robust rolling time window instead of one instantaneous sample', () => {
  assert.match(app, /function emaRate\(/);
  assert.match(app, /samples/);
  assert.match(app, /15000/);
  assert.match(app, /median/);
  assert.match(app, /0\.25/);
  assert.match(app, /4/);
  assert.match(app, /timeWeighted|weighted/i);
});

test('network incidents are persisted with connection context and bounded history', () => {
  assert.match(app, /dx-pwa-network-errors-v1/);
  assert.match(app, /networkConnectionSnapshot/);
  assert.match(app, /recordNetworkIncident/);
  assert.match(app, /slice\(-100\)|slice\(0,100\)|length>100/);
  assert.match(mobile, /dx-pwa-network-errors-v1/);
  assert.match(mobile, /dx-network-history/);
});

test('slow network detection dynamically contracts and recovers transfer concurrency', () => {
  assert.match(app, /networkAdaptiveConcurrencyLimit/);
  assert.match(app, /networkAdaptiveState/);
  assert.match(app, /slow-2g|2g/);
  assert.match(app, /512\s*\*\s*1024/);
  assert.match(app, /networkAdaptiveConcurrencyLimit\s*=\s*1/);
  assert.match(app, /workerIndex\s*>=\s*Math\.max\(1,\s*networkAdaptiveConcurrencyLimit/);
  assert.match(app, /maybeTestNetworkForLargeTransfer\(candidates\)/);
});

test('large-file Wi-Fi-only policy is configurable independently from global Wi-Fi-only mode', () => {
  assert.match(index, /id="large-wifi-only"/);
  assert.match(index, /id="large-wifi-threshold"/);
  assert.match(app, /dx-pwa-large-wifi-only/);
  assert.match(app, /dx-pwa-large-wifi-threshold/);
  assert.match(app, /function wifiPolicyRequired\(it\)/);
  assert.match(app, /largeWifiThresholdBytes/);
  assert.match(app, /waitUntilWifi\(it\)/);
});

test('unified timeline combines server activity, local transfers and network incidents', () => {
  assert.match(mobile, /dx-unified-timeline/);
  assert.match(mobile, /\/app\/activity\/recent\?limit=500/);
  assert.match(mobile, /indexedDB\.open/);
  assert.match(mobile, /dx-pwa-network-errors-v1/);
  assert.match(mobile, /dx-timeline-source/);
  assert.match(mobile, /setInterval|setTimeout/);
});

test('voice universal search uses browser speech recognition and triggers existing universal search', () => {
  assert.match(mobile, /SpeechRecognition\|\|window\.webkitSpeechRecognition/);
  assert.match(mobile, /share-global-search/);
  assert.match(mobile, /share-global-search-btn/);
  assert.match(mobile, /fr-CA/);
  assert.match(mobile, /originalPlaceholder/);
});

test('localized manifests expose Android launch shortcuts for voice, activity and quick widget', () => {
  for (const file of ['pwa/manifest.webmanifest','pwa/manifest-en.webmanifest','pwa/manifest-es.webmanifest']) {
    const m = manifest(file);
    const urls = new Set((m.shortcuts || []).map((x) => x.url));
    for (const url of ['/app/?action=files','/app/?action=camera','/app/?action=voice-search','/app/?action=activity','/app/?action=widget','/app/?action=destination']) {
      assert.ok(urls.has(url), `${file} missing ${url}`);
    }
  }
  assert.match(mobile, /\?action=widget|action==='widget'/);
  assert.match(mobile, /dx-widget-overlay/);
  assert.match(mobile, /dx-widget-open/);
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

test('fresh unauthenticated PWA bootstrap can fetch the new module and manifests', { timeout:25000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-mobile-features-'));
  const dirs = { host:path.join(temp,'host'), data:path.join(temp,'data'), images:path.join(temp,'images'), inbox:path.join(temp,'inbox') };
  Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive:true }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd:root,
    env:{ ...process.env, PORT:String(port), HOST_ROOT:dirs.host, DATA_DIR:dirs.data, IMAGES_DIR:dirs.images, INBOX_DIR:dirs.inbox, UPDATE_CHECK:'false', PUBLIC_URL:'' },
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  try {
    await waitFor(base + '/healthz', child, logs);
    const mod = await fetch(base + '/app/mobile-intelligence.js?v=444');
    assert.equal(mod.status, 200);
    assert.match(await mod.text(), /SpeechRecognition/);
    for (const name of ['manifest.webmanifest','manifest-en.webmanifest','manifest-es.webmanifest']) {
      const r = await fetch(base + '/app/' + name + '?v=444');
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.ok((body.shortcuts || []).some((x) => x.url === '/app/?action=widget'));
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 1500); });
    fs.rmSync(temp, { recursive:true, force:true });
  }
});
