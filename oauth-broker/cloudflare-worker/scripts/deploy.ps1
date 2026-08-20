$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "Direct-Xfer - déploiement du broker OAuth public Cloudflare" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 20+ est requis." }
if (-not (Test-Path package-lock.json)) { npm install --package-lock-only | Out-Host }
npm ci | Out-Host
npx wrangler whoami | Out-Host

$dbName = 'direct-xfer-oauth-broker'
$list = (npx wrangler d1 list --json | ConvertFrom-Json)
$db = $list | Where-Object { $_.name -eq $dbName } | Select-Object -First 1
if (-not $db) {
  Write-Host "Création de la base D1 $dbName..." -ForegroundColor Yellow
  # Cloudflare recommande de laisser D1 choisir automatiquement la localisation
  # sauf contrainte spécifique de juridiction/latence.
  npx wrangler d1 create $dbName | Out-Host
  $db = (npx wrangler d1 list --json | ConvertFrom-Json) | Where-Object { $_.name -eq $dbName } | Select-Object -First 1
}
$dbId = ''
if ($db) {
  if ($null -ne $db.uuid -and -not [string]::IsNullOrWhiteSpace([string]$db.uuid)) { $dbId = [string]$db.uuid }
  elseif ($null -ne $db.id) { $dbId = [string]$db.id }
}
if ([string]::IsNullOrWhiteSpace($dbId)) { throw "Impossible de déterminer l'identifiant D1." }

$config = Get-Content (Join-Path $Root 'wrangler.jsonc.example') -Raw
$config = $config.Replace('REPLACE_WITH_D1_DATABASE_ID', $dbId)
[System.IO.File]::WriteAllText((Join-Path $Root 'wrangler.jsonc'), $config, (New-Object System.Text.UTF8Encoding($false)))
npx wrangler d1 migrations apply $dbName --remote | Out-Host

function Test-WorkerExists {
  try {
    $null = npx wrangler deployments list --json 2>$null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

function Get-ExistingSecretNames([bool]$workerExists) {
  try {
    $raw = npx wrangler secret list --format json 2>$null
    if ($LASTEXITCODE -ne 0) {
      if ($workerExists) { throw 'Impossible de lire les secrets du Worker existant. Arrêt pour éviter toute rotation accidentelle de BROKER_DATA_KEY.' }
      return @()
    }
    if (-not $raw) { return @() }
    $items = $raw | ConvertFrom-Json
    return @($items | ForEach-Object { [string]$_.name })
  } catch {
    if ($workerExists) { throw }
    return @()
  }
}

function Write-Utf8NoBom([string]$path, [string]$content) {
  [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-DeployWithSecrets([hashtable]$values) {
  $secretFile = Join-Path $env:TEMP ("direct-xfer-oauth-broker-secrets-{0}.json" -f [guid]::NewGuid())
  try {
    Write-Utf8NoBom $secretFile ($values | ConvertTo-Json -Compress)
    $lines = npx wrangler deploy --secrets-file $secretFile 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($lines -join "`n") }
    $lines | Out-Host
    return ($lines -join "`n")
  } finally { Remove-Item $secretFile -Force -ErrorAction SilentlyContinue }
}

function Get-CredentialCount {
  $raw = npx wrangler d1 execute $dbName --remote --command "SELECT COUNT(*) AS count FROM credentials" --json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) { throw 'Impossible de vérifier les credentials D1 existants.' }
  $parsed = $raw | ConvertFrom-Json
  $first = @($parsed)[0]
  if ($null -eq $first -or $null -eq $first.results -or @($first.results).Count -lt 1) { throw 'Réponse D1 inattendue pendant le comptage des credentials.' }
  return [int64](@($first.results)[0].count)
}

function Set-GoogleSecrets([string]$clientId, [string]$clientSecret) {
  $secretFile = Join-Path $env:TEMP ("direct-xfer-oauth-broker-google-{0}.json" -f [guid]::NewGuid())
  try {
    Write-Utf8NoBom $secretFile (@{ GOOGLE_CLIENT_ID=$clientId; GOOGLE_CLIENT_SECRET=$clientSecret } | ConvertTo-Json -Compress)
    $lines = npx wrangler secret bulk $secretFile 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($lines -join "`n") }
    $lines | Out-Host
  } finally { Remove-Item $secretFile -Force -ErrorAction SilentlyContinue }
}

function Deploy-CodeOnly {
  $lines = npx wrangler deploy 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($lines -join "`n") }
  $lines | Out-Host
  return ($lines -join "`n")
}

$workerExists = Test-WorkerExists
$secretNames = @(Get-ExistingSecretNames $workerExists)
$hasDataKey = $secretNames -contains 'BROKER_DATA_KEY'
$hasGoogleSecrets = ($secretNames -contains 'GOOGLE_CLIENT_ID') -and ($secretNames -contains 'GOOGLE_CLIENT_SECRET')
$deployOutput = ''

if (-not $hasDataKey) {
  Write-Host "`nPremier déploiement : création de la clé de chiffrement persistante..." -ForegroundColor Yellow
  $brokerKeyBytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($brokerKeyBytes) } finally { $rng.Dispose() }
  $brokerKey = [Convert]::ToBase64String($brokerKeyBytes)
  $deployOutput = Invoke-DeployWithSecrets @{
    GOOGLE_CLIENT_ID='bootstrap.disabled.apps.googleusercontent.com'
    GOOGLE_CLIENT_SECRET='bootstrap.disabled'
    BROKER_DATA_KEY=$brokerKey
  }
} else {
  Write-Host "`nBROKER_DATA_KEY existante détectée : elle sera conservée." -ForegroundColor Green
  if (-not $hasGoogleSecrets) {
    Write-Host "Ajout temporaire des secrets Google requis avant publication..." -ForegroundColor Yellow
    Set-GoogleSecrets 'bootstrap.disabled.apps.googleusercontent.com' 'bootstrap.disabled'
  }
  $deployOutput = Deploy-CodeOnly
}

$match = [regex]::Match($deployOutput, 'https://[A-Za-z0-9._-]+\.workers\.dev')
if (-not $match.Success) {
  $existing = Join-Path $Root 'deployment-result.txt'
  if (Test-Path $existing) {
    $saved = Get-Content $existing | Where-Object { $_ -like 'DIRECT_XFER_OAUTH_BROKER_URL=*' } | Select-Object -First 1
    if ($saved) { $match = [regex]::Match($saved, 'https://[^\s]+') }
  }
}
if (-not $match.Success) { throw "Le Worker a été publié mais son URL workers.dev n'a pas pu être détectée." }
$brokerUrl = $match.Value.TrimEnd('/')
$callback = "$brokerUrl/v1/google/callback"

Write-Host "`nBroker public : $brokerUrl" -ForegroundColor Green
Write-Host "Callback Google unique : $callback" -ForegroundColor Green

$infoReady = $false
try {
  $info = Invoke-RestMethod -Uri "$brokerUrl/v1/info" -TimeoutSec 15
  $infoReady = [bool]$info.google
} catch {}

if ($infoReady) {
  $answer = Read-Host "Google est déjà configuré. Conserver les identifiants actuels ? [O/n]"
  if ([string]::IsNullOrWhiteSpace($answer) -or $answer -match '^[OoYy]') {
    Write-Host "Identifiants Google existants conservés." -ForegroundColor Green
  } else { $infoReady = $false }
}

if (-not $infoReady) {
  $existingCredentials = Get-CredentialCount
  $forceReplace = [string]$env:DX_OAUTH_BROKER_FORCE_GOOGLE_CREDENTIAL_REPLACE -eq '1'
  if ($existingCredentials -gt 0 -and -not $forceReplace) {
    throw "Refus de remplacer le client Google : $existingCredentials credential(s) broker existent déjà. Conservez les identifiants actuels ou définissez explicitement DX_OAUTH_BROKER_FORCE_GOOGLE_CREDENTIAL_REPLACE=1 après avoir planifié la reconnexion des remotes."
  }
  Write-Host "`nCréez UN client OAuth Google de type 'Application Web' pour le broker central." -ForegroundColor Cyan
  Write-Host "Ajoutez exactement cette URI dans 'URI de redirection autorisés' :" -ForegroundColor Cyan
  Write-Host $callback -ForegroundColor White
  try { Start-Process 'https://console.cloud.google.com/auth/clients' } catch {}
  Read-Host "Quand le client Google Web est créé, appuyez sur Entrée"

  $googleId = Read-Host 'Google Web Client ID (xxxx.apps.googleusercontent.com)'
  $googleSecretSecure = Read-Host 'Google Web Client Secret' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($googleSecretSecure)
  try { $googleSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  if ($googleId -notmatch '^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$' -or [string]::IsNullOrWhiteSpace($googleSecret)) { throw 'Client ID / Secret Google invalide.' }

  Write-Host "`nActivation des identifiants Google sans rotation de BROKER_DATA_KEY..." -ForegroundColor Yellow
  Set-GoogleSecrets $googleId $googleSecret
  $deployOutput = Deploy-CodeOnly
}

try {
  $info = Invoke-RestMethod -Uri "$brokerUrl/v1/info" -TimeoutSec 15
  if (-not $info.google -or $info.storage -eq $false) { throw 'Le broker répond mais Google/D1 n est pas prêt.' }
} catch { throw "Déploiement terminé, mais le test /v1/info a échoué : $($_.Exception.Message)" }

Write-Utf8NoBom (Join-Path $Root 'deployment-result.txt') ((@(
  "DIRECT_XFER_OAUTH_BROKER_URL=$brokerUrl",
  "GOOGLE_REDIRECT_URI=$callback"
) -join [Environment]::NewLine) + [Environment]::NewLine)

Write-Host "`nBroker OAuth Direct-Xfer PUBLIC et actif." -ForegroundColor Green
Write-Host "URL : $brokerUrl" -ForegroundColor Green
Write-Host "Direct-Xfer : DIRECT_XFER_OAUTH_BROKER_URL=$brokerUrl" -ForegroundColor Green
