param(
  [string]$Ref = 'main',
  [bool]$SignWithSignPath = $false
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:GH_TOKEN)) {
  throw 'GH_TOKEN is required to dispatch the Windows build workflow.'
}
if ([string]::IsNullOrWhiteSpace($env:GITHUB_REPOSITORY)) {
  throw 'GITHUB_REPOSITORY is required to dispatch the Windows build workflow.'
}
if (-not (Test-Path -LiteralPath 'package.json' -PathType Leaf)) {
  throw 'package.json is missing from the checked-out release tree.'
}
if (-not (Test-Path -LiteralPath '.github/workflows/build-windows-csharp.yml' -PathType Leaf)) {
  throw 'build-windows-csharp.yml is missing from the checked-out release tree.'
}

$package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
$releaseVersion = [string]$package.version
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') {
  throw "Invalid Direct-Xfer package version '$releaseVersion'."
}

$windowsWorkflow = Get-Content -LiteralPath '.github/workflows/build-windows-csharp.yml' -Raw
$escapedVersion = [regex]::Escape($releaseVersion)
if ($windowsWorkflow -notmatch "(?m)^run-name:\s*v$escapedVersion\s*$") {
  throw "Windows workflow run-name is not synchronized with Direct-Xfer $releaseVersion."
}
if ($windowsWorkflow -notmatch "(?m)^\s*DX_VERSION:\s*'$escapedVersion'\s*$") {
  throw "Windows workflow DX_VERSION is not synchronized with Direct-Xfer $releaseVersion."
}

$signValue = $SignWithSignPath.ToString().ToLowerInvariant()
Write-Host "Dispatching Direct-Xfer Windows build for v$releaseVersion from ref '$Ref' (SignPath=$signValue)."

gh workflow run build-windows-csharp.yml `
  --repo $env:GITHUB_REPOSITORY `
  --ref $Ref `
  -f "sign_with_signpath=$signValue"

if ($LASTEXITCODE -ne 0) {
  throw "Failed to dispatch build-windows-csharp.yml (exit code $LASTEXITCODE)."
}

Write-Host "Windows build dispatch accepted for Direct-Xfer v$releaseVersion."
