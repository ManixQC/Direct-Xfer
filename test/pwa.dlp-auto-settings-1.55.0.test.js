'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const app = fs.readFileSync(path.join(root,'pwa','app.js'),'utf8');
const html = fs.readFileSync(path.join(root,'pwa','index.html'),'utf8');
const server = fs.readFileSync(path.join(root,'server.js'),'utf8');

test('PWA settings expose the automatic DLP severity controls', () => {
  for (const id of ['dlp-auto-rules','dlp-action-low','dlp-action-medium','dlp-action-high','dlp-action-critical','dlp-auto-save']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(app,/savePwaDlpAutomaticRules/);
  assert.match(app,/rulesEnabled:d\.rulesEnabled === true/);
  assert.match(app,/\['warn','block','log','quarantine'\]/,'quarantine must survive policy sanitization');
  assert.match(server,/app\.post\('\/app\/dlp\/settings'/);
  assert.match(server,/editable: pwaViewerIsAdmin\(req\)/);
});
