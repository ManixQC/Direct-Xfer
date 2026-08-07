<#
.SYNOPSIS
    v2 - Reconstruit uniquement les métadonnées Git locales de Direct-Xfer
    sans modifier les fichiers de travail actuels.

.DESCRIPTION
    Conçu après un reset total de l'historique GitHub.

    Ce script :
      - NE FAIT PAS de reset --hard ;
      - NE SUPPRIME AUCUN fichier de ton projet ;
      - accepte un working tree avec fichiers modifiés/non suivis ;
      - vérifie que GitHub est propre :
          * une seule branche main
          * aucun tag
          * un seul commit racine
          * aucune mention de Claude dans l'identité du commit distant
      - déplace l'ancien .git HORS du dossier Direct-Xfer ;
      - crée un nouveau .git propre ;
      - rattache main au nouveau origin/main ;
      - conserve tous tes fichiers actuels exactement tels quels ;
      - configure l'identité locale ManixQC ;
      - vérifie que le nouvel historique local ne référence qu'un seul commit.

    L'ancien .git est conservé dans le dossier parent sous :
        Direct-Xfer-OLD-GIT-<date>

    Une fois que tu as vérifié que tout est correct, tu peux supprimer ce
    dossier OLD-GIT manuellement si tu veux éliminer aussi cette copie locale
    de l'ancien historique.

.EXAMPLE
    cd "C:\Users\Francis\Desktop\Projet partage de fichiers"
    .\reconstruire_git_local_propre.ps1

.EXAMPLE
    .\reconstruire_git_local_propre.ps1 `
      -RepoPath "C:\Users\Francis\Desktop\Projet partage de fichiers"
#>

[CmdletBinding()]
param(
    [string]$RepoPath = (Get-Location).Path,
    [string]$Owner = "ManixQC",
    [string]$Repo = "Direct-Xfer",
    [string]$Branch = "main",
    [string]$GitUserName = "ManixQC",
    [string]$GitUserEmail = "103022398+ManixQC@users.noreply.github.com"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$FullRepo = "$Owner/$Repo"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Write-Section {
    param([string]$Text)

    Write-Host ""
    Write-Host ("=" * 78) -ForegroundColor DarkCyan
    Write-Host " $Text" -ForegroundColor Cyan
    Write-Host ("=" * 78) -ForegroundColor DarkCyan
}

function Write-Step {
    param([string]$Text)
    Write-Host ""
    Write-Host ">> $Text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "[OK] $Text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Text)
    Write-Host "[AVERTISSEMENT] $Text" -ForegroundColor Yellow
}

function Invoke-ProcessCapture {
    param(
        [Parameter(Mandatory=$true)][string]$FilePath,
        [Parameter(Mandatory=$true)][string[]]$Arguments,
        [string]$WorkingDirectory = ""
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $psi.WorkingDirectory = $WorkingDirectory
    }

    $quotedArgs = @(
        foreach ($arg in $Arguments) {
            $s = [string]$arg

            if ($s -notmatch '[\s"]') {
                $s
                continue
            }

            $escaped = $s -replace '(\\*)"', '$1$1\"'
            $escaped = $escaped -replace '(\\+)$', '$1$1'
            '"' + $escaped + '"'
        }
    )

    $psi.Arguments = ($quotedArgs -join " ")

    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi

    if (-not $p.Start()) {
        throw "Impossible de démarrer $FilePath."
    }

    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()

    $p.WaitForExit()

    [pscustomobject]@{
        ExitCode = $p.ExitCode
        StdOut = $stdout
        StdErr = $stderr
    }
}

function Invoke-Git {
    param(
        [Parameter(Mandatory=$true)][string[]]$Arguments,
        [string]$WorkingDirectory = $RepoPath,
        [switch]$AllowFailure,
        [switch]$ShowOutput
    )

    $r = Invoke-ProcessCapture `
        -FilePath "git.exe" `
        -Arguments $Arguments `
        -WorkingDirectory $WorkingDirectory

    if ($ShowOutput) {
        if (-not [string]::IsNullOrWhiteSpace($r.StdOut)) {
            Write-Host $r.StdOut.TrimEnd()
        }

        if (-not [string]::IsNullOrWhiteSpace($r.StdErr)) {
            if ($r.ExitCode -eq 0) {
                Write-Host $r.StdErr.TrimEnd()
            }
            else {
                Write-Host $r.StdErr.TrimEnd() -ForegroundColor Red
            }
        }
    }

    if (($r.ExitCode -ne 0) -and (-not $AllowFailure)) {
        throw "git $($Arguments -join ' ') a échoué.`n$($r.StdErr)"
    }

    return $r
}

# PowerShell déroule les collections retournées par une fonction.
# Tous les appels à Get-Lines sont donc enveloppés dans @(...)
# afin que 0, 1 ou plusieurs lignes restent toujours un tableau.
function Get-Lines {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return @()
    }

    @(
        $Text -split "`r?`n" |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
}

Write-Section "RECONSTRUCTION DU .GIT LOCAL - FICHIERS CONSERVES"

if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    throw "Git for Windows est introuvable."
}

$RepoPath = [System.IO.Path]::GetFullPath($RepoPath)

if (-not (Test-Path -LiteralPath $RepoPath -PathType Container)) {
    throw "Dossier introuvable : $RepoPath"
}

$OldGitDir = Join-Path $RepoPath ".git"

if (-not (Test-Path -LiteralPath $OldGitDir -PathType Container)) {
    throw "Aucun dossier .git trouvé dans $RepoPath."
}

$repoCheck = Invoke-Git `
    -Arguments @("rev-parse", "--show-toplevel") `
    -AllowFailure

if ($repoCheck.ExitCode -ne 0) {
    throw "Le dossier actuel n'est pas un dépôt Git valide."
}

$topLevel = $repoCheck.StdOut.Trim()

if ([System.IO.Path]::GetFullPath($topLevel).TrimEnd("\") -ne $RepoPath.TrimEnd("\")) {
    throw "La racine Git détectée est '$topLevel'. Utilise cette racine comme RepoPath."
}

Write-Host "Dossier conservé : $RepoPath"
Write-Host ""

# ---------------------------------------------------------------------------
# INVENTAIRE DU TRAVAIL ACTUEL
# ---------------------------------------------------------------------------

Write-Section "1 - INVENTAIRE DU TRAVAIL LOCAL"

$statusBefore = Invoke-Git `
    -Arguments @("status", "--short", "--untracked-files=all")

$statusLines = @(Get-Lines $statusBefore.StdOut)

Write-Host "Modifications/fichiers locaux détectés : $($statusLines.Count)"

if ($statusLines.Count -gt 0) {
    Write-Host ""
    Write-Host "Ils seront CONSERVES, pas écrasés :" -ForegroundColor Green

    foreach ($line in $statusLines) {
        Write-Host "  $line"
    }
}

# ---------------------------------------------------------------------------
# VALIDATION DE L'ORIGIN ACTUEL
# ---------------------------------------------------------------------------

Write-Section "2 - VALIDATION DU DEPOT GITHUB PROPRE"

$originResult = Invoke-Git `
    -Arguments @("remote", "get-url", "origin") `
    -AllowFailure

if ($originResult.ExitCode -ne 0) {
    throw "Le remote origin est introuvable."
}

$OriginUrl = $originResult.StdOut.Trim()

Write-Host "origin actuel : $OriginUrl"

$expectedHttps = "https://github.com/$FullRepo.git"
$expectedSshSuffix = "github.com:$FullRepo.git"

$isExpectedOrigin = (
    ($OriginUrl -eq $expectedHttps) -or
    ($OriginUrl.EndsWith($expectedSshSuffix, [System.StringComparison]::OrdinalIgnoreCase)) -or
    ($OriginUrl -eq "https://github.com/$FullRepo")
)

if (-not $isExpectedOrigin) {
    throw "Le remote origin ne correspond pas à $FullRepo. Aucun changement effectué."
}

Write-Step "Lecture directe des refs GitHub"

$headsResult = Invoke-Git `
    -Arguments @("ls-remote", "--heads", $OriginUrl)

$tagsResult = Invoke-Git `
    -Arguments @("ls-remote", "--tags", $OriginUrl)

$remoteHeads = @(Get-Lines $headsResult.StdOut)
$remoteTags = @(Get-Lines $tagsResult.StdOut)

if ($remoteHeads.Count -ne 1) {
    throw "GitHub contient $($remoteHeads.Count) branches au lieu d'une seule."
}

if ($remoteHeads[0] -notmatch "refs/heads/$([regex]::Escape($Branch))$") {
    throw "La seule branche GitHub n'est pas '$Branch'."
}

if ($remoteTags.Count -ne 0) {
    throw "GitHub contient encore $($remoteTags.Count) tag(s). Aucun changement local effectué."
}

Write-Ok "GitHub : 1 branche '$Branch', 0 tag."

# On utilise un dépôt temporaire pour vérifier l'historique distant sans
# s'appuyer sur les refs potentiellement anciennes du .git local.
$TempVerify = Join-Path ([System.IO.Path]::GetTempPath()) "dx-verify-$Timestamp"

try {
    New-Item -ItemType Directory -Path $TempVerify -Force | Out-Null

    $initVerify = Invoke-Git `
        -WorkingDirectory $TempVerify `
        -Arguments @("init", "-q")

    $remoteVerify = Invoke-Git `
        -WorkingDirectory $TempVerify `
        -Arguments @("remote", "add", "origin", $OriginUrl)

    Write-Step "Fetch minimal du nouveau main"

    $fetchVerify = Invoke-Git `
        -WorkingDirectory $TempVerify `
        -Arguments @(
            "fetch",
            "--no-tags",
            "--depth=1",
            "origin",
            "$Branch`:refs/remotes/origin/$Branch"
        ) `
        -ShowOutput

    $countText = (
        Invoke-Git `
            -WorkingDirectory $TempVerify `
            -Arguments @("rev-list", "--count", "refs/remotes/origin/$Branch")
    ).StdOut.Trim()

    $count = 0

    if (-not [int]::TryParse($countText, [ref]$count)) {
        throw "Impossible de vérifier le nombre de commits distants."
    }

    if ($count -ne 1) {
        throw "Le nouveau GitHub contient $count commits au lieu de 1."
    }

    $parentText = (
        Invoke-Git `
            -WorkingDirectory $TempVerify `
            -Arguments @(
                "rev-list",
                "--parents",
                "-n",
                "1",
                "refs/remotes/origin/$Branch"
            )
    ).StdOut.Trim()

    $parentParts = @(
        $parentText -split "\s+" |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )

    if ($parentParts.Count -ne 1) {
        throw "Le commit distant possède encore un parent."
    }

    $identity = (
        Invoke-Git `
            -WorkingDirectory $TempVerify `
            -Arguments @(
                "show",
                "-s",
                "--format=%an|%ae",
                "refs/remotes/origin/$Branch"
            )
    ).StdOut.Trim()

    if ($identity -match "(?i)claude") {
        throw "L'identité du commit distant mentionne encore Claude : $identity"
    }

    $CleanCommitSha = $parentParts[0]

    Write-Ok "Historique GitHub validé : 1 seul commit racine."
    Write-Host "Commit : $CleanCommitSha"
    Write-Host "Auteur : $identity"
}
finally {
    Remove-Item -LiteralPath $TempVerify -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# EMPLACEMENT DE SAUVEGARDE DE L'ANCIEN .GIT
# ---------------------------------------------------------------------------

$ParentDir = Split-Path -Parent $RepoPath
$RepoFolderName = Split-Path -Leaf $RepoPath
$OldGitBackup = Join-Path $ParentDir "$RepoFolderName-OLD-GIT-$Timestamp"

Write-Section "3 - CONFIRMATION"

Write-Host "AUCUN fichier de ton projet ne sera supprimé ou remplacé." -ForegroundColor Green
Write-Host ""
Write-Host "L'ancien .git sera déplacé ici :" -ForegroundColor Yellow
Write-Host "  $OldGitBackup"
Write-Host ""
Write-Host "Puis un nouveau .git propre sera créé dans :" -ForegroundColor Cyan
Write-Host "  $RepoPath"
Write-Host ""
Write-Host "Tes fichiers modifiés et nouveaux resteront dans le dossier." -ForegroundColor Green
Write-Host "Après l'opération, ils apparaîtront dans 'git status' et tu pourras les committer." -ForegroundColor Green
Write-Host ""

$confirmation = Read-Host "Tape exactement 'REBUILD LOCAL GIT' pour continuer"

if ($confirmation -cne "REBUILD LOCAL GIT") {
    Write-Host ""
    Write-Host "Annulé. Rien n'a été modifié." -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# SAUVEGARDE / SORTIE DE L'ANCIEN .GIT
# ---------------------------------------------------------------------------

Write-Section "4 - SORTIE DE L'ANCIEN HISTORIQUE"

# Garde une copie texte de quelques infos utiles.
$OldInfoFile = Join-Path $ParentDir "$RepoFolderName-OLD-GIT-INFO-$Timestamp.txt"

$oldInfo = New-Object System.Collections.Generic.List[string]
$oldInfo.Add("Ancien dépôt local avant reconstruction")
$oldInfo.Add("Date : $(Get-Date -Format o)")
$oldInfo.Add("Dossier : $RepoPath")
$oldInfo.Add("Origin : $OriginUrl")
$oldInfo.Add("")
$oldInfo.Add("git status --short :")
foreach ($line in $statusLines) {
    $oldInfo.Add($line)
}

[System.IO.File]::WriteAllLines(
    $OldInfoFile,
    $oldInfo,
    (New-Object System.Text.UTF8Encoding($false))
)

Write-Step "Déplacement de .git hors du projet"

try {
    Move-Item `
        -LiteralPath $OldGitDir `
        -Destination $OldGitBackup `
        -Force
}
catch {
    throw "Impossible de déplacer l'ancien .git. Tes fichiers n'ont pas été modifiés. $($_.Exception.Message)"
}

if (Test-Path -LiteralPath $OldGitDir) {
    throw "L'ancien .git existe encore dans le projet. Arrêt."
}

if (-not (Test-Path -LiteralPath $OldGitBackup)) {
    throw "La sauvegarde OLD-GIT n'a pas été créée."
}

Write-Ok "Ancien historique sorti du dossier Direct-Xfer."

# ---------------------------------------------------------------------------
# CONSTRUCTION DU NOUVEAU .GIT
# ---------------------------------------------------------------------------

Write-Section "5 - CREATION DU NOUVEAU .GIT"

try {
    Write-Step "git init"

    Invoke-Git `
        -Arguments @("init", "-b", $Branch) `
        -ShowOutput | Out-Null

    Write-Step "Ajout de origin"

    Invoke-Git `
        -Arguments @("remote", "add", "origin", $OriginUrl) | Out-Null

    Write-Step "Fetch minimal : main seulement, aucun tag"

    Invoke-Git `
        -Arguments @(
            "fetch",
            "--no-tags",
            "--depth=1",
            "origin",
            "$Branch`:refs/remotes/origin/$Branch"
        ) `
        -ShowOutput | Out-Null

    # Fait pointer main sur origin/main SANS checkout et SANS toucher aux fichiers.
    Write-Step "Rattachement de main au nouveau commit propre"

    Invoke-Git `
        -Arguments @(
            "update-ref",
            "refs/heads/$Branch",
            "refs/remotes/origin/$Branch"
        ) | Out-Null

    Invoke-Git `
        -Arguments @(
            "symbolic-ref",
            "HEAD",
            "refs/heads/$Branch"
        ) | Out-Null

    # Construit uniquement l'index depuis HEAD.
    # Le working tree n'est pas modifié.
    Invoke-Git `
        -Arguments @(
            "reset",
            "--mixed",
            "HEAD"
        ) `
        -ShowOutput | Out-Null

    Invoke-Git `
        -Arguments @(
            "branch",
            "--set-upstream-to=origin/$Branch",
            $Branch
        ) `
        -ShowOutput | Out-Null

    Invoke-Git `
        -Arguments @(
            "remote",
            "set-head",
            "origin",
            "-a"
        ) `
        -AllowFailure `
        -ShowOutput | Out-Null

    Write-Step "Configuration de l'identité ManixQC"

    Invoke-Git `
        -Arguments @(
            "config",
            "--local",
            "user.name",
            $GitUserName
        ) | Out-Null

    Invoke-Git `
        -Arguments @(
            "config",
            "--local",
            "user.email",
            $GitUserEmail
        ) | Out-Null

    # Empêche un git fetch normal de récupérer des tags implicitement.
    Invoke-Git `
        -Arguments @(
            "config",
            "--local",
            "remote.origin.tagOpt",
            "--no-tags"
        ) | Out-Null

    # Nettoyage immédiat du tout nouveau .git.
    Invoke-Git `
        -Arguments @(
            "reflog",
            "expire",
            "--expire=now",
            "--all"
        ) `
        -AllowFailure | Out-Null

    Invoke-Git `
        -Arguments @(
            "gc",
            "--prune=now"
        ) `
        -AllowFailure | Out-Null
}
catch {
    Write-Host ""
    Write-Host "ERREUR pendant la création du nouveau .git :" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""

    # Restauration automatique de l'ancien .git si possible.
    if (Test-Path -LiteralPath $OldGitBackup) {
        Write-Warn "Tentative de restauration automatique de l'ancien .git..."

        if (Test-Path -LiteralPath $OldGitDir) {
            Remove-Item -LiteralPath $OldGitDir -Recurse -Force -ErrorAction SilentlyContinue
        }

        try {
            Move-Item `
                -LiteralPath $OldGitBackup `
                -Destination $OldGitDir `
                -Force

            Write-Ok "Ancien .git restauré."
        }
        catch {
            Write-Warn "Restauration automatique impossible."
            Write-Host "Ancien .git conservé ici : $OldGitBackup"
        }
    }

    throw
}

# ---------------------------------------------------------------------------
# VERIFICATIONS FINALES
# ---------------------------------------------------------------------------

Write-Section "6 - VERIFICATIONS FINALES"

$countAfterText = (
    Invoke-Git -Arguments @("rev-list", "--all", "--count")
).StdOut.Trim()

$countAfter = 0

if (-not [int]::TryParse($countAfterText, [ref]$countAfter)) {
    throw "Impossible de lire le nombre final de commits."
}

$tagsAfter = @(
    Get-Lines (
        Invoke-Git `
            -Arguments @(
                "for-each-ref",
                "--format=%(refname)",
                "refs/tags/"
            )
    ).StdOut
)

$branchesAfter = @(
    Get-Lines (
        Invoke-Git `
            -Arguments @(
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads/"
            )
    ).StdOut
)

$identityAfter = (
    Invoke-Git `
        -Arguments @(
            "show",
            "-s",
            "--format=%an|%ae|%P",
            "HEAD"
        )
).StdOut.Trim()

$headSha = (
    Invoke-Git -Arguments @("rev-parse", "HEAD")
).StdOut.Trim()

$originSha = (
    Invoke-Git -Arguments @("rev-parse", "origin/$Branch")
).StdOut.Trim()

if ($countAfter -ne 1) {
    throw "Vérification échouée : $countAfter commits sont encore référencés localement."
}

if ($tagsAfter.Count -ne 0) {
    throw "Vérification échouée : des tags locaux existent encore."
}

if (($branchesAfter.Count -ne 1) -or ($branchesAfter[0] -ne $Branch)) {
    throw "Vérification échouée : les branches locales ne sont pas réduites à '$Branch'."
}

if ($headSha -ne $originSha) {
    throw "Vérification échouée : HEAD ne correspond pas à origin/$Branch."
}

if ($identityAfter -match "(?i)claude") {
    throw "Vérification échouée : le commit propre mentionne encore Claude."
}

Write-Ok "Historique local : 1 commit."
Write-Ok "Tags locaux : 0."
Write-Ok "Branche locale : $Branch."
Write-Ok "HEAD = origin/$Branch."
Write-Ok "Commit courant : $identityAfter"
Write-Ok "Identité pour les prochains commits : $GitUserName <$GitUserEmail>."

# ---------------------------------------------------------------------------
# CONFIRMATION QUE LES FICHIERS DE TRAVAIL SONT TOUJOURS LA
# ---------------------------------------------------------------------------

Write-Section "7 - TON TRAVAIL LOCAL EST CONSERVE"

$statusAfter = Invoke-Git `
    -Arguments @("status", "--short", "--untracked-files=all")

$statusAfterLines = @(Get-Lines $statusAfter.StdOut)

if ($statusAfterLines.Count -eq 0) {
    Write-Host "Le working tree correspond exactement au nouveau main." -ForegroundColor Green
}
else {
    Write-Host "Tes modifications/nouveaux fichiers sont toujours présents :" -ForegroundColor Green
    Write-Host ""

    foreach ($line in $statusAfterLines) {
        Write-Host "  $line"
    }
}

Write-Host ""
Write-Host "Ancien .git conservé HORS du projet :" -ForegroundColor Yellow
Write-Host "  $OldGitBackup"
Write-Host ""
Write-Host "Le dépôt Direct-Xfer actif n'utilise plus cet ancien historique." -ForegroundColor Green
Write-Host ""
Write-Host "Prochaine étape conseillée :" -ForegroundColor Cyan
Write-Host "  git status"
Write-Host "  git diff"
Write-Host ""
Write-Host "Quand tu as vérifié tes changements actuels :" -ForegroundColor Cyan
Write-Host "  git add -A"
Write-Host "  git commit -m `"Mise à jour Direct-Xfer`""
Write-Host "  git push"
Write-Host ""
Write-Host "Si tout fonctionne après quelques jours, tu peux supprimer :" -ForegroundColor Yellow
Write-Host "  $OldGitBackup"
Write-Host ""
Write-Host "RECONSTRUCTION TERMINEE." -ForegroundColor Green
