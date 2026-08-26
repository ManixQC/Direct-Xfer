'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const dockerfile = read('Dockerfile');
const trivy = read('.github/workflows/trivy.yml');
const openvex = JSON.parse(read('security/openvex.json'));
const pkg = JSON.parse(read('package.json'));
const releaseVersion = pkg.version;
const trivyIgnore = read('.trivyignore.yaml');

function runtimeInstallBlock() {
  const marker = '# Pull all Debian security updates before installing the OCR/PDF runtime.';
  const start = dockerfile.indexOf(marker);
  assert.notEqual(start, -1, 'runtime hardening block must exist');
  const end = dockerfile.indexOf('\nCOPY --from=dependencies /app/node_modules', start);
  assert.notEqual(end, -1, 'runtime hardening block must have a stable end marker');
  return dockerfile.slice(start, end);
}

test(`${releaseVersion} builds Tesseract 5.5.3 from the exact signed-release commit with optional surfaces disabled`, () => {
  const firstFrom = dockerfile.indexOf('FROM ');
  const versionDefault = dockerfile.indexOf('ARG DX_TESSERACT_BUILD_VERSION=5.5.3');
  const commitDefault = dockerfile.indexOf('ARG DX_TESSERACT_BUILD_COMMIT=db0ec62f81b0737fbbe184d8fea40af5738f8eef');
  assert.ok(versionDefault >= 0 && versionDefault < firstFrom, 'Tesseract version ARG default must be global so later stages inherit it');
  assert.ok(commitDefault >= 0 && commitDefault < firstFrom, 'Tesseract commit ARG default must be global so later stages inherit it');
  assert.match(dockerfile, /FROM node:22\.23\.2-trixie-slim@sha256:[0-9a-f]{64} AS tesseract-builder\nARG DX_TESSERACT_BUILD_VERSION\nARG DX_TESSERACT_BUILD_COMMIT/);
  assert.match(dockerfile, /ARG DX_TESSERACT_BUILD_VERSION=5\.5\.3/);
  assert.match(dockerfile, /ARG DX_TESSERACT_BUILD_COMMIT=db0ec62f81b0737fbbe184d8fea40af5738f8eef/);
  assert.match(dockerfile, /git -C \/src\/tesseract fetch --depth=1 origin/);
  assert.match(dockerfile, /refs\/tags\/\$\{DX_TESSERACT_BUILD_VERSION\}:refs\/tags\/\$\{DX_TESSERACT_BUILD_VERSION\}/);
  assert.match(dockerfile, /cat-file -t refs\/tags\/\$\{DX_TESSERACT_BUILD_VERSION\}/);
  assert.match(dockerfile, /rev-parse refs\/tags\/\$\{DX_TESSERACT_BUILD_VERSION\}\^\{commit\}/);
  assert.match(dockerfile, /checkout --detach "refs\/tags\/\$\{DX_TESSERACT_BUILD_VERSION\}\^\{commit\}"/);
  assert.doesNotMatch(dockerfile, /git clone --depth=1 --branch/);
  assert.match(dockerfile, /test "\$\(git -C \/src\/tesseract rev-parse HEAD\)" = "\$\{DX_TESSERACT_BUILD_COMMIT\}"/);
  assert.match(dockerfile, /test "\$\(cat \/src\/tesseract\/VERSION\)" = "\$\{DX_TESSERACT_BUILD_VERSION\}"/);
  assert.match(dockerfile, /WORKDIR \/src\/tesseract/);
  assert.doesNotMatch(dockerfile, /&&\s+cd \/src\/tesseract/);
  assert.match(dockerfile, /-DBUILD_SHARED_LIBS=OFF/);
  assert.match(dockerfile, /-DBUILD_TRAINING_TOOLS=OFF/);
  assert.match(dockerfile, /-DGRAPHICS_DISABLED=ON/);
  assert.match(dockerfile, /-DDISABLE_ARCHIVE=ON/);
  assert.match(dockerfile, /-DDISABLE_CURL=ON/);
  assert.match(dockerfile, /COPY --from=tesseract-builder \/out\/tesseract \/usr\/local\/bin\/tesseract/);
  assert.match(dockerfile, /tesseract --version \| head -n 1 \| grep -Fx "tesseract \$\{DX_TESSERACT_BUILD_VERSION\}"/);
});

test(`${releaseVersion} final image omits Debian Tesseract binaries and keeps only required OCR language/runtime packages`, () => {
  const runtime = runtimeInstallBlock();
  assert.doesNotMatch(runtime, /^\s+tesseract-ocr \\$/m);
  for (const pkg of ['libleptonica6', 'tesseract-ocr-eng', 'tesseract-ocr-fra', 'tesseract-ocr-osd', 'tesseract-ocr-spa']) {
    assert.match(runtime, new RegExp(`^\\s+${pkg.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')} \\\\$`, 'm'));
  }
  assert.match(runtime, /dpkg-query -W -f='\$\{db:Status-Status\}' tesseract-ocr/);
  assert.match(runtime, /dpkg-query -W -f='\$\{db:Status-Status\}' libtesseract5/);
  assert.match(runtime, /dpkg-query -L tesseract-ocr-eng/);
  assert.match(runtime, /tessdata_dir="\$\(dirname "\$tessdata_eng"\)"/);
  assert.match(runtime, /for lang in eng fra osd spa; do test -s "\$tessdata_dir\/\$lang\.traineddata"/);
  assert.match(runtime, /TESSDATA_PREFIX=\/usr\/share\/tesseract-ocr\/5\/tessdata tesseract --list-langs/);
  assert.doesNotMatch(runtime, /TESSDATA_PREFIX=\/usr\/share\/tesseract-ocr\/5 tesseract --list-langs/);
  assert.match(runtime, /for unused in pdfattach pdfdetach pdffonts pdfimages pdfinfo pdfseparate pdfsig pdftocairo pdfunite text2image/);
  assert.match(dockerfile, /TESSDATA_PREFIX=\/usr\/share\/tesseract-ocr\/5\/tessdata \\/);
  assert.doesNotMatch(dockerfile, /TESSDATA_PREFIX=\/usr\/share\/tesseract-ocr\/5 \\/);
  assert.ok((runtime.match(/RUN set -eux;/g) || []).length >= 4, 'runtime setup must stay split into diagnostic layers');
});

test(`${releaseVersion} OpenVEX is narrow, package-scoped, and removes the old unsound Cairo suppression`, () => {
  assert.equal(openvex['@id'], `https://github.com/ManixQC/Direct-Xfer/security/openvex-${releaseVersion}`);
  const byId = new Map(openvex.statements.map((s) => [s.vulnerability.name || s.vulnerability['@id'], s]));
  assert.ok(byId.has('CVE-2026-8376'));
  assert.ok(byId.has('CVE-2024-45993'));
  assert.ok(byId.has('CVE-2006-5201'));
  assert.equal(byId.has('CVE-2025-50422'), false, 'Cairo/Poppler finding must remain visible until fixed or proven non-applicable');
  const perl = byId.get('CVE-2026-8376');
  assert.equal(perl.status, 'not_affected');
  assert.ok(perl.products.length >= 2);
  for (const product of perl.products) assert.match(product['@id'], /^pkg:deb\/debian\/.+\?arch=amd64$/);
  for (const statement of openvex.statements) {
    for (const product of statement.products) assert.doesNotMatch(product['@id'], /^pkg:(?:docker|oci)\//);
  }
});

test(`${releaseVersion} keeps the intentional Docker root bootstrap exception narrow and reviewable`, () => {
  assert.match(trivyIgnore, /^misconfigurations:/m);
  assert.match(trivyIgnore, /id: AVD-DS-0002/);
  assert.match(trivyIgnore, /paths:\n\s+- Dockerfile/);
  assert.match(trivyIgnore, /expired_at: 2027-02-26/);
  assert.match(trivyIgnore, /setpriv/);
  assert.doesNotMatch(trivyIgnore, /^vulnerabilities:/m);
  assert.doesNotMatch(trivyIgnore, /^secrets:/m);
});

test(`${releaseVersion} Trivy produces a complete report but gates only fixable, VEX-reviewed findings`, () => {
  assert.match(trivy, /TRIVY_ENGINE_VERSION: v0\.74\.0/);
  assert.match(trivy, /Generate complete repository report[\s\S]*?format: json[\s\S]*?output: trivy-repository-full\.json/);
  assert.match(trivy, /Generate complete image report[\s\S]*?format: json[\s\S]*?output: trivy-image-full\.json/);
  assert.match(trivy, /trivy convert[\s\S]*?trivy-repository-full\.json \| tee trivy-repository-full\.txt/);
  assert.match(trivy, /trivy convert[\s\S]*?trivy-image-full\.json \| tee trivy-image-full\.txt/);
  assert.match(trivy, /Scan actionable repository findings[\s\S]*?TRIVY_VEX: security\/openvex\.json[\s\S]*?ignore-unfixed: true[\s\S]*?trivyignores: \.trivyignore\.yaml/);
  assert.match(trivy, /Scan actionable image findings[\s\S]*?TRIVY_VEX: security\/openvex\.json[\s\S]*?ignore-unfixed: true[\s\S]*?trivyignores: \.trivyignore\.yaml/);
  assert.match(trivy, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(trivy, /github\/codeql-action\/upload-sarif@[0-9a-f]{40}/);
  assert.match(trivy, /docker build --pull --platform=linux\/amd64/);
  assert.match(trivy, /Upload image Trivy reports[\s\S]*?hashFiles\('trivy-image-full\.json'\)/);
  assert.match(trivy, /\.Architecture}}'\)" = "amd64"/);
});


test(`${releaseVersion} OAuth broker image runs as the unprivileged node user with writable persistent data`, () => {
  const broker = read('oauth-broker/Dockerfile');
  const compose = read('oauth-broker/docker-compose.yml');
  assert.match(broker, /COPY --chown=node:node server\.js \.\/server\.js/);
  assert.match(broker, /install -d -o node -g node -m 0700 \/data/);
  assert.match(broker, /^USER node$/m);
  assert.match(compose, /direct-xfer-oauth-broker-data:\/data/);
  assert.match(compose, /^volumes:\n  direct-xfer-oauth-broker-data:$/m);
});
