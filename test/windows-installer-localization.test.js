'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

const installer = read('installer/Direct-Xfer.iss');

test('Windows installer offers the three Direct-Xfer languages before the wizard', () => {
  assert.match(installer, /^ShowLanguageDialog=yes$/m);
  assert.match(installer, /^LanguageDetectionMethod=uilanguage$/m);
  assert.match(installer, /^Name: "en"; MessagesFile: "compiler:Default\.isl"$/m);
  assert.match(installer, /^Name: "fr"; MessagesFile: "compiler:Languages\\French\.isl"; InfoBeforeFile: "PRIVACY\.fr\.txt"$/m);
  assert.match(installer, /^Name: "es"; MessagesFile: "compiler:Languages\\Spanish\.isl"; InfoBeforeFile: "PRIVACY\.es\.txt"$/m);
});

test('Direct-Xfer-specific installer text is localized instead of hard-coded in English', () => {
  for (const key of ['TaskAutostart', 'TaskUpdateCheck', 'TaskPublicIp', 'TaskDesktopIcon', 'RunDirectXfer', 'NodeRuntimeInvalid', 'DotNetRuntimeInvalid', 'ServerHostStopTimeout']) {
    for (const lang of ['en', 'fr', 'es']) {
      assert.match(installer, new RegExp(`^${lang}\\.${key}=.+$`, 'm'));
    }
  }
  assert.match(installer, /Name: "autostart"; Description: "\{cm:TaskAutostart\}"/);
  assert.match(installer, /Name: "updatecheck"; Description: "\{cm:TaskUpdateCheck\}"/);
  assert.match(installer, /Name: "publicip"; Description: "\{cm:TaskPublicIp\}"/);
  assert.match(installer, /Description: "\{cm:RunDirectXfer\}"/);
  assert.match(installer, /RaiseException\(CustomMessage\('NodeRuntimeInvalid'\)\)/);
  assert.match(installer, /RaiseException\(CustomMessage\('DotNetRuntimeInvalid'\)\)/);
  assert.match(installer, /Result := CustomMessage\('ServerHostStopTimeout'\)/);
});

test('French and Spanish privacy pages exist and are actually bound to their installer languages', () => {
  const fr = read('installer/PRIVACY.fr.txt');
  const es = read('installer/PRIVACY.es.txt');
  assert.match(fr, /Confidentialité de Direct-Xfer/);
  assert.match(fr, /REQUÊTES RÉSEAU SORTANTES/);
  assert.match(es, /Privacidad de Direct-Xfer/);
  assert.match(es, /SOLICITUDES DE RED SALIENTES/);
});
