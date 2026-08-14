'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('photo editor gives the image a large contained workspace', () => {
  assert.match(css, /\.annotate-dialog\s*\{[\s\S]*?width:\s*min\(1400px,\s*100%\)[\s\S]*?height:\s*calc\(100dvh\s*-\s*24px\)/);
  assert.match(css, /#annotate-canvas\s*\{[\s\S]*?max-width:\s*100%[\s\S]*?max-height:\s*100%[\s\S]*?object-fit:\s*contain/);
  assert.match(css, /@media\(min-width:900px\)[\s\S]*?grid-template-columns:minmax\(0,1\.7fr\) minmax\(320px,\.7fr\)/);
  assert.match(css, /@media\(max-width:720px\)[\s\S]*?width:100vw;height:100dvh[\s\S]*?min-height:42dvh/);
  assert.doesNotMatch(css, /#annotate-canvas\s*\{[^}]*max-height:\s*68dvh/);
});

test('each uploaded image exposes the photo editor action', () => {
  assert.match(app, /class="btn ghost sm il-photo-edit"/);
  assert.match(app, /photoEditBtn\.title\s*=\s*t\('imgEditUploaded'\)/);
  assert.match(app, /photoEditBtn\.addEventListener\('click',[\s\S]*?editUploadedImage\(imageRecordsByToken\.get\(data\.token\) \|\| data\)/);
  assert.match(app, /\['\.il-open',[\s\S]*?'\.il-photo-edit'/);
});

test('editing an uploaded image uses the private full preview and mutates only after Apply', () => {
  const start = app.indexOf('async function editUploadedImage(photo)');
  const end = app.indexOf('async function replaceImageKeepingUrl(photo)', start);
  assert.ok(start > 0 && end > start);
  const body = app.slice(start, end);
  assert.match(body, /photo\.previewUrls && photo\.previewUrls\.full \|\| \('\/app\/image\/'.*'\/preview\/full'\)/s);
  assert.match(body, /credentials:\s*'same-origin',\s*cache:\s*'no-store'/);
  assert.match(body, /await openImageLinkEditor\(sourceFile\)/);
  assert.match(body, /if \(!edited \|\| edited === sourceFile\) return;/);
  assert.ok(body.indexOf('edited === sourceFile') < body.indexOf('commitImageReplacement('));
  assert.match(body, /metadataStripped:\s*true/);
});

test('edited bytes replace the same token and regenerate image variants', () => {
  const start = app.indexOf('async function commitImageReplacement(photo');
  const end = app.indexOf('async function editUploadedImage(photo)', start);
  assert.ok(start > 0 && end > start);
  const body = app.slice(start, end);
  assert.match(body, /\/app\/image\/.*photo\.token.*\/replace\?name=/s);
  assert.match(body, /uploadGeneratedImageVariants\(photo\.token, variants\)/);
  assert.match(body, /applyUpdatedImageRecord\(updated\)/);
  assert.match(server, /app\.post\('\/app\/image\/:token\/replace'/);
  assert.match(server, /archiveCurrentPhotoVersion\(photo\)/);
  assert.match(server, /res\.json\(\{ ok: true, image: pwaPhotoPayload\(req, photo\)/);
});

test('JPEG Mini and Micro variants flatten transparency onto white', () => {
  assert.match(app, /context\.fillStyle\s*=\s*'#fff';\s*context\.fillRect\(0, 0, canvas\.width, canvas\.height\);/);
});
