param(
  [Parameter(Mandatory = $true)]
  [string]$NodeModulesPath
)

$ErrorActionPreference = 'Stop'

function Get-DxTreeBytes([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return [int64]0 }
  $sum = (Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return [int64]0 }
  return [int64]$sum
}

$root = [System.IO.Path]::GetFullPath($NodeModulesPath)
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
  throw "node_modules directory does not exist: $root"
}

$beforeBytes = Get-DxTreeBytes $root

# Remove development-only directory trees only when they are direct children of an
# installed package root. This avoids deleting an arbitrary runtime folder merely because a
# package author happened to name it "test" internally.
$discardDirectoryNames = @(
  '.circleci', '.github', '.nyc_output', '.vscode',
  'benchmark', 'benchmarks', 'coverage',
  'doc', 'docs', 'example', 'examples',
  'test', 'tests', 'testing'
)

$packageRoots = @(Get-ChildItem -LiteralPath $root -Recurse -Force -File -Filter 'package.json' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.Directory.FullName } | Sort-Object -Unique)
foreach ($packageRoot in $packageRoots) {
  foreach ($directoryName in $discardDirectoryNames) {
    $candidate = Join-Path $packageRoot $directoryName
    if (Test-Path -LiteralPath $candidate -PathType Container) {
      Remove-Item -LiteralPath $candidate -Recurse -Force
    }
  }
}

# Keep package.json, licenses and executable/runtime assets. Only metadata that Node never
# needs to execute a package is removed here.
$discardExactFileNames = @(
  '.eslintrc', '.eslintignore', '.jshintrc', '.npmignore',
  'bower.json', 'component.json',
  '.package-lock.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'
)
$discardDocumentationPattern = '^(README|CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|AUTHORS)(\.(MD|MARKDOWN|TXT|RST))?$'

$files = @(Get-ChildItem -LiteralPath $root -Recurse -Force -File -ErrorAction SilentlyContinue)
foreach ($file in $files) {
  $name = $file.Name
  $upper = $name.ToUpperInvariant()
  $remove = $false

  if ($discardExactFileNames -contains $name) {
    $remove = $true
  } elseif ($file.Extension -eq '.map' -or $upper.EndsWith('.D.TS') -or $upper.EndsWith('.TSBUILDINFO')) {
    # Source maps and TypeScript declaration/build metadata are not consumed by Node at
    # runtime. Ordinary .ts files are intentionally retained for Node 24 compatibility.
    $remove = $true
  } elseif ($upper -match $discardDocumentationPattern) {
    $remove = $true
  }

  # License/copyright/notice material must always remain in the redistributed package.
  if ($upper.StartsWith('LICENSE') -or $upper.StartsWith('LICENCE') -or
      $upper.StartsWith('COPYING') -or $upper.StartsWith('NOTICE') -or
      $upper.StartsWith('COPYRIGHT')) {
    $remove = $false
  }

  if ($remove -and (Test-Path -LiteralPath $file.FullName -PathType Leaf)) {
    Remove-Item -LiteralPath $file.FullName -Force
  }
}

# Remove directories left empty by the metadata cleanup, but never package roots that still
# contain package.json or scoped-package containers with children.
$emptyDirectories = @(Get-ChildItem -LiteralPath $root -Recurse -Force -Directory -ErrorAction SilentlyContinue |
  Sort-Object { $_.FullName.Length } -Descending)
foreach ($directory in $emptyDirectories) {
  if (-not (Test-Path -LiteralPath $directory.FullName -PathType Container)) { continue }
  $children = @(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction SilentlyContinue)
  if ($children.Count -eq 0) {
    Remove-Item -LiteralPath $directory.FullName -Force
  }
}

$afterBytes = Get-DxTreeBytes $root
if ($afterBytes -le 0) { throw 'node_modules pruning produced an empty runtime tree.' }
if ($afterBytes -gt $beforeBytes) { throw 'node_modules pruning unexpectedly increased the runtime tree.' }

$savedBytes = $beforeBytes - $afterBytes
$percent = if ($beforeBytes -gt 0) { [math]::Round(($savedBytes * 100.0) / $beforeBytes, 1) } else { 0 }
Write-Host ("Direct-Xfer node_modules production prune: {0:N1} MiB -> {1:N1} MiB (saved {2:N1} MiB / {3}%)" -f ($beforeBytes / 1MB), ($afterBytes / 1MB), ($savedBytes / 1MB), $percent)
