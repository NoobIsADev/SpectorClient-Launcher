$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/NoobIsADev/SpectorClient-Launcher.git'
$RepoName = 'NoobIsADev/SpectorClient-Launcher'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PackagePath = Join-Path $ProjectRoot 'package.json'

function Run-Git {
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string[]]$GitArgs
    )

    & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
}

# Check a remote tag from the cloned checkout, not the extracted ZIP folder.
# `git ls-remote --exit-code` returns 2 for an absent tag and can throw under
# Windows PowerShell 5.1 when native command errors are redirected. Without
# --exit-code, a missing tag is a successful empty result instead.
function Assert-TagAvailable {
    param(
        [Parameter(Mandatory=$true)][string]$CheckoutPath,
        [Parameter(Mandatory=$true)][string]$ReleaseTag
    )

    if (-not (Test-Path -LiteralPath (Join-Path $CheckoutPath '.git'))) {
        throw "The cloned Git working directory is missing: $CheckoutPath"
    }
    $RemoteTagRefs = @(& git -C $CheckoutPath ls-remote --refs --tags origin "refs/tags/$ReleaseTag")
    $Status = $LASTEXITCODE
    if ($Status -ne 0) {
        throw "Cannot check GitHub release tag $ReleaseTag (git exit code $Status). No source was pushed."
    }
    if ($RemoteTagRefs.Count -gt 0) {
        throw "$ReleaseTag already exists on GitHub. Bump package.json before releasing again. No source was pushed."
    }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is not installed. Install Git for Windows from https://git-scm.com/download/win, then run this file again.'
}

if (-not (Test-Path $PackagePath)) {
    throw "package.json was not found at $PackagePath"
}

$Package = Get-Content $PackagePath -Raw | ConvertFrom-Json
$Version = [string]$Package.version
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    throw "package.json has an invalid version: $Version"
}
$Tag = "v$Version"

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("spectorclient-push-" + [guid]::NewGuid().ToString('N'))
$Checkout = Join-Path $TempRoot 'repo'
New-Item -ItemType Directory -Path $TempRoot | Out-Null

try {
    Write-Host "[1/8] Cloning $RepoName..." -ForegroundColor Cyan
    Run-Git @('clone', $RepoUrl, $Checkout)

    # Preflight using the newly cloned repository. The extracted source ZIP
    # deliberately has no .git folder and no `origin` remote.
    Write-Host "Checking that release tag $Tag is available..." -ForegroundColor Cyan
    Assert-TagAvailable -CheckoutPath $Checkout -ReleaseTag $Tag

    Write-Host '[2/8] Copying the prepared launcher source...' -ForegroundColor Cyan

    # Overlay the prepared launcher source without deleting files that exist
    # only in the GitHub repository. This keeps earlier tracked progress and
    # avoids wiping remote-only work when starting from a source ZIP.
    # Exclude .git/node_modules/output folders; never use robocopy /MIR.
    if (-not (Test-Path -LiteralPath (Join-Path $Checkout '.git'))) {
        throw 'The temporary Git checkout lost its .git directory before the source copy.'
    }

    $excludeDirs = @('.git', 'node_modules', 'dist', 'out', '.cache')
    $xd = @()
    foreach ($dir in $excludeDirs) { $xd += @('/XD', (Join-Path $ProjectRoot $dir)) }
    $robocopyArgs = @($ProjectRoot, $Checkout, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') + $xd
    & robocopy @robocopyArgs | Out-Null
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed with exit code $LASTEXITCODE"
    }

    if (-not (Test-Path (Join-Path $Checkout '.git'))) {
        throw 'The temporary Git checkout lost its .git directory during the source copy.'
    }

    Push-Location $Checkout
    try {

        # Set a local identity only if Git has no usable identity already.
        $existingName = (& git config user.name 2>$null)
        $existingEmail = (& git config user.email 2>$null)
        if (-not $existingName) { Run-Git @('config', 'user.name', 'NoobIsADev') }
        if (-not $existingEmail) { Run-Git @('config', 'user.email', 'NoobIsADev@users.noreply.github.com') }

        Write-Host '[3/8] Creating the source commit...' -ForegroundColor Cyan
        Run-Git @('add', '-A')
        & git diff --cached --quiet
        if ($LASTEXITCODE -eq 0) {
            Write-Host 'No source changes need to be committed.' -ForegroundColor Yellow
        } elseif ($LASTEXITCODE -eq 1) {
            Run-Git @('commit', '-m', "Release SpectorClient $Version with automatic updates")
        } else {
            throw "git diff --cached --quiet failed with exit code $LASTEXITCODE"
        }

        Write-Host '[4/8] Pushing main...' -ForegroundColor Cyan
        Run-Git @('push', 'origin', 'HEAD:main')

        Write-Host "[5/8] Creating release tag $Tag..." -ForegroundColor Cyan
        # Recheck immediately before tagging, in case another release was
        # created while this source was being pushed.
        Assert-TagAvailable -CheckoutPath $Checkout -ReleaseTag $Tag

        Run-Git @('tag', '-a', $Tag, '-m', "SpectorClient $Version")
        Run-Git @('push', 'origin', $Tag)

        Write-Host '[6/8] Waiting for the GitHub Actions release build...' -ForegroundColor Cyan
        $ApiHeaders = @{ 'User-Agent' = 'SpectorClient-Release-Script'; 'Cache-Control' = 'no-cache' }
        $Run = $null
        for ($i = 1; $i -le 30; $i++) {
            try {
                $runs = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoName/actions/runs?branch=$Tag&per_page=5" -Headers $ApiHeaders
                $Run = @($runs.workflow_runs | Where-Object { $_.head_branch -eq $Tag }) | Select-Object -First 1
                if ($Run) { break }
            } catch {}
            Start-Sleep -Seconds 4
        }
        if (-not $Run) {
            throw "GitHub Actions did not start for $Tag. Check https://github.com/$RepoName/actions"
        }

        while ($true) {
            $Run = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoName/actions/runs/$($Run.id)" -Headers $ApiHeaders
            Write-Host "  Release workflow: $($Run.status)" -ForegroundColor DarkCyan
            if ($Run.status -eq 'completed') { break }
            Start-Sleep -Seconds 10
        }
        if ($Run.conclusion -ne 'success') {
            throw "GitHub Actions failed for $Tag. Open $($Run.html_url) to see the failed step."
        }

        Write-Host '[7/8] Verifying published updater files...' -ForegroundColor Cyan
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoName/releases/tags/$Tag" -Headers $ApiHeaders
        $ExpectedAssets = @(
            "SpectorClient-$Version-x64.exe",
            "SpectorClient-$Version-x64.exe.blockmap",
            'latest.yml',
            "SpectorClient-$Version-x86_64.AppImage",
            'latest-linux.yml',
            "SpectorClient-$Version-universal.dmg",
            "SpectorClient-$Version-universal.zip",
            'latest-mac.yml'
        )
        $ActualAssets = @($Release.assets | ForEach-Object { $_.name })
        foreach ($Asset in $ExpectedAssets) {
            if ($ActualAssets -notcontains $Asset) {
                throw "GitHub release $Tag is missing $Asset even though the workflow completed."
            }
        }
        if ($Release.draft -or $Release.prerelease) {
            throw "GitHub release $Tag was not published as a normal release."
        }

        Write-Host '[8/8] Done.' -ForegroundColor Green
        Write-Host ''
        Write-Host "SpectorClient $Version is published with Windows + Linux + macOS release files." -ForegroundColor Green
        Write-Host "Release: $($Release.html_url)" -ForegroundColor Green
        Write-Host 'Actions: https://github.com/NoobIsADev/SpectorClient-Launcher/actions' -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}
finally {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
