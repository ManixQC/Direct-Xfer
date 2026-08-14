'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('1.51.2 uses the patched Debian container package stream', () => {
  const dockerfile = read('Dockerfile');
  const bases = dockerfile.match(/^FROM node:22-trixie-slim(?: AS dependencies)?$/gm) || [];
  assert.equal(bases.length, 2);
  assert.doesNotMatch(dockerfile, /node:22-alpine|\bapk\s+(?:add|upgrade)\b/);
  assert.match(dockerfile, /apt-get dist-upgrade -y/);
  for (const pkg of ['gosu', 'poppler-utils', 'tesseract-ocr', 'tesseract-ocr-eng', 'tesseract-ocr-fra', 'tesseract-ocr-spa']) {
    assert.match(dockerfile, new RegExp('\\b' + pkg.replace(/-/g, '\\-') + '\\b'));
  }
});

test('container build enforces the fixed giflib floor and removes unused Cairo frontends', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /dpkg-query[^\n]+libgif7/);
  assert.match(dockerfile, /dpkg --compare-versions "\$giflib_version" ge '5\.2\.2-1\+deb13u1'/);
  assert.match(dockerfile, /os-packages\.tsv/);
  assert.match(dockerfile, /rm -f \/usr\/bin\/pdftocairo \/usr\/bin\/text2image/);
  assert.match(dockerfile, /test ! -e \/usr\/bin\/pdftocairo/);
  assert.match(dockerfile, /test ! -e \/usr\/bin\/text2image/);
  assert.match(dockerfile, /exec gosu "\$PUID:\$PGID" "\$@"/);
  assert.doesNotMatch(dockerfile, /su-exec/);
});

test('OpenVEX records every finding from the supplied scan', () => {
  const vex = JSON.parse(read('security/openvex.json'));
  assert.equal(vex['@context'], 'https://openvex.dev/ns/v0.2.0');
  const statements = new Map(vex.statements.map((entry) => [entry.vulnerability['@id'], entry]));
  assert.equal(statements.get('CVE-2026-26740').status, 'fixed');
  assert.equal(statements.get('CVE-2026-23868').status, 'fixed');
  assert.equal(statements.get('CVE-2024-45993').justification, 'vulnerable_code_not_present');
  assert.equal(statements.get('CVE-2006-5201').justification, 'vulnerable_code_not_present');
  assert.equal(statements.get('CVE-2025-50422').justification, 'vulnerable_code_not_in_execute_path');
});
