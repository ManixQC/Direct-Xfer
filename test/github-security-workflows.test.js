"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("quality-only workflow checks never upload SARIF to Code Scanning", () => {
  for (const rel of [
    ".github/workflows/actionlint.yml",
    ".github/workflows/dependency-review.yml",
  ]) {
    const text = read(rel);
    assert.doesNotMatch(text, /^\s*security-events:\s*write\s*$/m);
    assert.doesNotMatch(text, /^\s*uses:\s*github\/codeql-action\/upload-sarif@/m);
  }
});

test("zizmor publishes only medium-confidence, medium-severity security findings", () => {
  const text = read(".github/workflows/zizmor.yml");
  assert.match(text, /zizmorcore\/zizmor-action@[0-9a-f]{40}/);
  assert.match(text, /advanced-security:\s*true/);
  assert.match(text, /min-severity:\s*medium/);
  assert.match(text, /min-confidence:\s*medium/);
  assert.match(text, /security-events:\s*write/);
});

test("OpenSSF Scorecard is the only new explicit SARIF uploader", () => {
  const scorecard = read(".github/workflows/scorecard.yml");
  assert.match(scorecard, /ossf\/scorecard-action@[0-9a-f]{40}/);
  assert.match(scorecard, /github\/codeql-action\/upload-sarif@[0-9a-f]{40}/);
  assert.match(scorecard, /category:\s*openssf-scorecard/);
  assert.match(scorecard, /security-events:\s*write/);
});

test("Dependency Review blocks newly introduced moderate-or-higher vulnerabilities", () => {
  const text = read(".github/workflows/dependency-review.yml");
  assert.match(text, /actions\/dependency-review-action@[0-9a-f]{40}/);
  assert.match(text, /fail-on-severity:\s*moderate/);
  assert.match(text, /show-openssf-scorecard:\s*false/);
});

test("actionlint download is versioned and checksum verified", () => {
  const text = read(".github/workflows/actionlint.yml");
  assert.match(text, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
  assert.match(text, /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/);
  assert.match(text, /sha256sum --check --strict/);
});

test("Windows provenance uses a separate least-privilege attestation job", () => {
  const text = read(".github/workflows/build-windows-csharp.yml");
  assert.match(text, /attest-windows-provenance:/);
  assert.match(text, /needs:\s*build-windows/);
  assert.match(text, /id-token:\s*write/);
  assert.match(text, /attestations:\s*write/);
  assert.match(text, /actions\/attest@[0-9a-f]{40}/);
  assert.match(text, /Direct-Xfer\.ServerHost\.exe/);
  assert.match(text, /Direct-Xfer-Setup-\$\{\{ env\.DX_VERSION \}\}\.exe/);
});

test("OpenSSF Scorecard keeps governance posture out of Code Scanning while preserving technical findings", () => {
  const scorecard = read(".github/workflows/scorecard.yml");
  const filter = read("scripts/filter-scorecard-sarif.js");
  assert.match(scorecard, /filter-scorecard-sarif\.js scorecard-results\.sarif scorecard-security\.sarif/);
  assert.match(scorecard, /sarif_file:\s*scorecard-security\.sarif/);
  assert.match(scorecard, /category:\s*openssf-scorecard/);
  assert.match(filter, /'CodeReviewID'/);
  assert.match(filter, /'ContributorsID'/);
  assert.match(filter, /'MaintainedID'/);
  assert.match(filter, /GOVERNANCE_ONLY_RULE_IDS/);
});

test("rclone Go dependency downloads retry transient network failures without disabling checksum verification", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /GOSUMDB=sum\.golang\.org/);
  assert.match(dockerfile, /GOPROXY=https:\/\/proxy\.golang\.org,direct/);
  assert.match(dockerfile, /GODEBUG=http2client=0/);
  assert.match(dockerfile, /retry_go go mod download "github\.com\/rclone\/rclone@\$\{DX_RCLONE_BUILD_VERSION\}"/);
  assert.match(dockerfile, /retry_go go get "golang\.org\/x\/image@\$\{DX_RCLONE_X_IMAGE_VERSION\}"/);
  assert.match(dockerfile, /retry_go go mod download all/);
  assert.match(dockerfile, /go mod verify/);
  assert.doesNotMatch(dockerfile, /GOSUMDB=off/);
  assert.doesNotMatch(dockerfile, /GONOSUMDB=\*/);
  const trivy = read(".github/workflows/trivy.yml");
  assert.match(trivy, /for attempt in 1 2 3; do/);
  assert.match(trivy, /Docker build hit a transient failure/);
  assert.match(trivy, /test "\$built" = "1"/);
});
