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

test("OpenSSF Scorecard uploads its filtered technical security SARIF", () => {
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

test("OpenSSF Scorecard uses an allowlist so only concrete technical findings reach Code Scanning", () => {
  const scorecard = read(".github/workflows/scorecard.yml");
  const filter = read("scripts/filter-scorecard-sarif.js");
  assert.match(scorecard, /filter-scorecard-sarif\.js scorecard-results\.sarif scorecard-security\.sarif/);
  assert.match(scorecard, /sarif_file:\s*scorecard-security\.sarif/);
  assert.match(scorecard, /category:\s*openssf-scorecard/);
  assert.match(filter, /CODE_SCANNING_RULE_IDS/);
  for (const id of ['DangerousWorkflowID', 'PinnedDependenciesID', 'TokenPermissionsID', 'VulnerabilitiesID']) {
    assert.match(filter, new RegExp(`'${id}'`));
  }
  for (const posture of ['CodeReviewID', 'BranchProtectionID', 'FuzzingID', 'SecurityPolicyID']) {
    assert.doesNotMatch(filter, new RegExp(`'${posture}'`));
  }
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


test("all third-party GitHub Actions are pinned to immutable commit SHAs", () => {
  const workflowDir = path.join(ROOT, ".github", "workflows");
  for (const name of fs.readdirSync(workflowDir).filter((x) => x.endsWith(".yml"))) {
    const text = fs.readFileSync(path.join(workflowDir, name), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/);
      if (!match) continue;
      const target = match[1];
      if (target.startsWith("./") || target.startsWith("docker://")) continue;
      assert.match(target, /@[0-9a-f]{40}$/, `${name}: unpinned action ${target}`);
    }
  }
});

test("Scorecard Token-Permissions writes are job-scoped rather than workflow-global", () => {
  const trivy = read(".github/workflows/trivy.yml");
  const trivyPreamble = trivy.slice(0, trivy.indexOf("jobs:"));
  assert.doesNotMatch(trivyPreamble, /^\s*security-events:\s*write\s*$/m);
  assert.match(trivy, /repository-scan:[\s\S]*?permissions:[\s\S]*?security-events:\s*write/);
  assert.match(trivy, /image-scan:[\s\S]*?permissions:[\s\S]*?security-events:\s*write/);

  const chain = read(".github/workflows/release-windows-build-chain.yml");
  const chainPreamble = chain.slice(0, chain.indexOf("jobs:"));
  assert.doesNotMatch(chainPreamble, /^\s*actions:\s*write\s*$/m);
  assert.match(chain, /dispatch-windows-build:[\s\S]*?permissions:[\s\S]*?actions:\s*write/);
});

test("container base images and Cloudflare deployment tooling are immutably or exactly pinned", () => {
  const dockerfile = read("Dockerfile");
  for (const line of dockerfile.split(/\r?\n/).filter((x) => /^FROM\s+/i.test(x))) {
    assert.match(line, /@sha256:[0-9a-f]{64}/, `unpinned Docker base: ${line}`);
  }
  const brokerDocker = read("oauth-broker/Dockerfile");
  assert.match(brokerDocker.split(/\r?\n/)[0], /node:22\.23\.2-alpine@sha256:[0-9a-f]{64}$/);
  const deploySh = read("oauth-broker/cloudflare-worker/scripts/deploy.sh");
  const deployPs = read("oauth-broker/cloudflare-worker/scripts/deploy.ps1");
  assert.doesNotMatch(deploySh, /npm install --package-lock-only/);
  assert.doesNotMatch(deployPs, /npm install --package-lock-only/);
  assert.match(deploySh, /wrangler@4\.94\.0/);
  assert.match(deployPs, /wrangler@4\.94\.0/);
});

test("repository publishes a non-public-disclosure security policy", () => {
  const policy = read(".github/SECURITY.md");
  assert.match(policy, /do not disclose suspected vulnerabilities in a public issue/i);
  assert.match(policy, /private vulnerability reporting/i);
});


test("Windows release dispatch keeps workflow inputs out of executable PowerShell", () => {
  const chain = read(".github/workflows/release-windows-build-chain.yml");
  const runBlockMatch = chain.match(/- name: Validate tested release and dispatch Windows build[\s\S]*?\n\s*run:\s*\|([\s\S]*?)(?=\n\s{6}- name:|\n\S|$)/);
  assert.ok(runBlockMatch, "release dispatch run block must exist");
  assert.doesNotMatch(runBlockMatch[1], /\$\{\{\s*inputs\./, "untrusted workflow inputs must not be template-expanded into PowerShell");
  assert.match(chain, /DX_RELEASE_REF:\s*\$\{\{ inputs\.ref \|\| 'main' \}\}/);
  assert.match(chain, /DX_SIGN_WITH_SIGNPATH:/);
  assert.match(runBlockMatch[1], /GetEnvironmentVariable\('DX_RELEASE_REF'\)/);
  assert.match(runBlockMatch[1], /-Ref \$releaseRef/);

  const dispatcher = read(".github/scripts/dispatch-windows-release-build.ps1");
  assert.match(dispatcher, /Invalid release ref/);
  assert.match(dispatcher, /\$Ref\.Contains\('\.\.'\)/);
  assert.match(dispatcher, /gh workflow run build-windows-csharp\.yml/);
});

test("OWASP ZAP DAST scans an isolated local target and sends only Medium/High findings to Code Scanning", () => {
  const workflow = read(".github/workflows/zap.yml");
  const converter = read("scripts/zap-report-to-sarif.js");
  const gate = read("scripts/check-zap-report.js");
  assert.match(workflow, /zaproxy\/action-baseline@[0-9a-f]{40}/);
  assert.match(workflow, /zaproxy\/zap-stable@sha256:[0-9a-f]{64}/);
  assert.match(workflow, /allow_issue_writing:\s*false/);
  assert.match(workflow, /fail_action:\s*false/);
  assert.match(workflow, /target:\s*http:\/\/127\.0\.0\.1:55750\//);
  assert.match(workflow, /ADMIN_ALLOW_ANY=true/);
  assert.match(workflow, /ADMIN_PASSWORD=\"\$\(openssl rand -hex 32\)\"\s+export ADMIN_PASSWORD/);
  assert.match(workflow, /--env ADMIN_PASSWORD/);
  assert.match(workflow, /zap-report-to-sarif\.js report_json\.json zap-security\.sarif/);
  assert.match(workflow, /category:\s*owasp-zap-baseline/);
  assert.match(workflow, /Enforce Medium\/High ZAP gate[\s\S]*?if:\s*always\(\)[\s\S]*?check-zap-report\.js report_json\.json/);
  assert.match(read("scripts/zap-report-utils.js"), /Invalid ZAP_MIN_RISK/);
  assert.match(converter, /automationDetails:\s*\{ id: 'owasp-zap\/baseline\/' \}/);
  assert.match(converter, /'security-severity'/);
  assert.match(converter, /artifactLocation: \{ uri: 'security\/zap-dast-target\.md' \}/);
  assert.match(workflow, /locations\[0\]\.physicalLocation\.artifactLocation\.uri == \"security\/zap-dast-target\.md\"/);
  assert.match(gate, /parseRiskCode\(alert\) >= minRisk/);
});

test("Windows provenance attests binaries while the project SBOM is bound to the source package it describes", () => {
  const text = read(".github/workflows/build-windows-csharp.yml");
  assert.match(text, /Checkout release SBOM/);
  assert.match(text, /Create SBOM-described source package/);
  assert.match(text, /git -C provenance\/source archive/);
  assert.match(text, /Direct-Xfer-\$\{DX_VERSION\}-source\.zip/);
  assert.match(text, /Direct-Xfer-\$\{DX_VERSION\}-SHA256SUMS\.txt/);
  assert.match(text, /sha256sum source\/security\/sbom\.cdx\.json/);
  assert.match(text, /sha256sum "Direct-Xfer-\$\{DX_VERSION\}-source\.zip"/);
  assert.match(text, /Direct-Xfer-\$\{\{ env\.DX_VERSION \}\}-provenance-metadata/);
  assert.match(text, /actions\/attest@[0-9a-f]{40}/);
  assert.match(text, /Generate GitHub SBOM attestation for source package/);
  assert.match(text, /subject-path:\s*provenance\/Direct-Xfer-\$\{\{ env\.DX_VERSION \}\}-source\.zip/);
  assert.match(text, /sbom-path:\s*provenance\/source\/security\/sbom\.cdx\.json/);
  const sbomStep = text.match(/- name: Generate GitHub SBOM attestation for source package[\s\S]*$/)?.[0] || '';
  assert.doesNotMatch(sbomStep, /subject-path:\s*\|[\s\S]*Direct-Xfer\.exe/, 'npm/source SBOM must not claim to describe the launcher apphost');
});
