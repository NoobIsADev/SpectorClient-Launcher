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
    Write-Host "[1/6] Cloning $RepoName..." -ForegroundColor Cyan
    Run-Git @('clone', $RepoUrl, $Checkout)

    Write-Host '[2/6] Copying the prepared launcher source...' -ForegroundColor Cyan

    # Clear the temporary working tree while preserving Git's metadata.
    # Do NOT use robocopy /MIR here: /MIR can purge the destination-only .git directory.
    Get-ChildItem -LiteralPath $Checkout -Force | Where-Object { $_.Name -ne '.git' } | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }

    if (-not (Test-Path (Join-Path $Checkout '.git'))) {
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

        Write-Host '[3/6] Creating the source commit...' -ForegroundColor Cyan
        Run-Git @('add', '-A')
        & git diff --cached --quiet
        if ($LASTEXITCODE -eq 0) {
            Write-Host 'No source changes need to be committed.' -ForegroundColor Yellow
        } elseif ($LASTEXITCODE -eq 1) {
            Run-Git @('commit', '-m', "Release SpectorClient $Version with automatic updates")
        } else {
            throw "git diff --cached --quiet failed with exit code $LASTEXITCODE"
        }

        Write-Host '[4/6] Pushing main...' -ForegroundColor Cyan
        Run-Git @('push', 'origin', 'HEAD:main')

        Write-Host "[5/6] Creating release tag $Tag..." -ForegroundColor Cyan
        & git ls-remote --exit-code --tags origin "refs/tags/$Tag" *> $null
        if ($LASTEXITCODE -eq 0) {
            throw "$Tag already exists on GitHub. Bump package.json to a new version before releasing again."
        }

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
            'latest-linux.yml'
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
        Write-Host "SpectorClient $Version is published with Windows + Linux updater files." -ForegroundColor Green
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
