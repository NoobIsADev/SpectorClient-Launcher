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

        Write-Host '[6/6] Done.' -ForegroundColor Green
        Write-Host ''
        Write-Host "GitHub Actions will build and publish SpectorClient $Version automatically." -ForegroundColor Green
        Write-Host 'Actions:  https://github.com/NoobIsADev/SpectorClient-Launcher/actions' -ForegroundColor Green
        Write-Host 'Releases: https://github.com/NoobIsADev/SpectorClient-Launcher/releases' -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}
finally {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
