# Builds dist\Webscraper.exe. Needs Node 20+ and Python 3.11+ on PATH.
#   ./packaging/desktop/build_windows.ps1
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

$venv = Join-Path $root 'packaging\desktop\.venv'
python -m venv $venv
$py = Join-Path $venv 'Scripts\python.exe'
& $py -m pip install --upgrade pip
& $py -m pip install -r services/engine/requirements.txt pyinstaller
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

& $py packaging/desktop/build.py
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

# Smoke test the frozen binary: both servers must boot and talk to each other.
$home_dir = Join-Path $env:RUNNER_TEMP 'webscraper-smoke'
if (-not $env:RUNNER_TEMP) { $home_dir = Join-Path $env:TEMP 'webscraper-smoke' }
$env:WEBSCRAPER_HOME = $home_dir
$p = Start-Process -FilePath dist\Webscraper.exe -ArgumentList '--smoke-test' -Wait -PassThru -NoNewWindow
if ($p.ExitCode -ne 0) { throw "smoke test failed (exit $($p.ExitCode))" }
Write-Host 'dist\Webscraper.exe built and smoke-tested.'
