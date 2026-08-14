'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const server = read('server.js');
const app = read('public','app.js');
const html = read('public','index.html');
const css = read('public','style.css');
const pwa = read('pwa','app.js');
const resume = read('public','media-resume.js');
const textRender = require('../lib/text-render');

test('PDF, text/code, audio and video previews are integrated safely', () => {
  assert.equal(textRender.renderKind('notes.txt'), 'text');
  assert.equal(textRender.renderKind('.env.production'), 'text');
  assert.equal(textRender.renderKind('main.tsx'), 'code');
  assert.equal(textRender.renderKind('manual.pdf'), 'pdf');
  for (const id of ['preview-image','preview-video','preview-audio','preview-frame','preview-text']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(server, /rendered === 'text' \|\| rendered === 'code' \|\| rendered === 'markdown'/);
  assert.match(server, /text\/plain; charset=utf-8/);
  assert.match(server, /kind === 'pdf'/);
  assert.match(server, /X-Frame-Options', 'SAMEORIGIN'/);
  assert.match(css, /\.preview-frame/);
});

test('audio/video resume is persistent on public, standard and PWA players', () => {
  assert.match(server, /\/media-resume\.js/);
  assert.match(server, /data-dx-resume="1"/);
  assert.match(resume, /dx-media-pos-v1:/);
  assert.match(resume, /timeupdate/);
  assert.match(app, /dx-admin-media-v2:/);
  assert.match(pwa, /dx-pwa-media-v1:/);
  assert.match(pwa, /previewResumeKey/);
});

test('DLP has severity actions including persistent quarantine', () => {
  assert.match(server, /dlpRulesEnabled: false/);
  assert.match(server, /dlpActionHigh: 'quarantine'/);
  assert.match(server, /function dlpEffectiveAction/);
  assert.match(server, /mode === 'quarantine'/);
  assert.match(server, /DLP_QUARANTINE_DIR/);
  assert.match(server, /EXDEV/);
  assert.match(server, /dlp-quarantined/);
  assert.match(html, /id="cfg-dlp-rules"/);
  for (const id of ['cfg-dlp-low','cfg-dlp-medium','cfg-dlp-high','cfg-dlp-critical']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(pwa, /pwaDlpEffectiveAction/);
  assert.match(pwa, /dlpLocalQuarantined/);
});

test('managed image duplicate detection is enforced by server SHA-256', () => {
  assert.match(server, /contentHash = crypto\.createHash\('sha256'\)/);
  assert.match(server, /findManagedPhotoDuplicateDeep/);
  assert.match(server, /error:'duplicate-content'/);
  assert.match(server, /contentSha256:sha256/);
  assert.match(server, /String\(item\.contentSha256 \|\| ''\).*String\(item\.clientHash \|\| ''\)/s);
  assert.match(app, /duplicateOverride=1/);
  assert.match(pwa, /duplicateOverride=1/);
});
