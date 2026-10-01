# Builds the portable folder, the zip, the Setup.exe and SHA256SUMS.txt in dist\.
# Needs Node 20+ and Python 3.11+ on PATH.   ./packaging/desktop/build_windows.ps1
# Set WEBSCRAPER_VERSION (e.g. 0.2.0) to stamp the build; defaults to package.json.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

$venv = Join-Path $root 'packaging\desktop\.venv'
python -m venv $venv
$py = Join-Path $venv 'Scripts\python.exe'
& $py -m pip install --upgrade pip
& $py -m pip install -r services/engine/requirements.txt pyinstaller pytest
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

# Unit tests for the updater (checksum, zip-slip, version logic).
& $py -m pytest -q packaging/desktop/tests -p no:cacheprovider
if ($LASTEXITCODE -ne 0) { throw 'updater tests failed' }

& $py packaging/desktop/build.py
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

$tmp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$exe = Join-Path $root 'dist\Webscraper\Webscraper.exe'

# 1. Smoke test the frozen app: both servers boot, talk to each other, the
#    control channel and settings API enforce their guards.
$env:WEBSCRAPER_HOME = Join-Path $tmp 'webscraper-smoke'
$p = Start-Process -FilePath $exe -ArgumentList '--smoke-test' -Wait -PassThru -NoNewWindow
if ($p.ExitCode -ne 0) { throw "smoke test failed (exit $($p.ExitCode))" }
Remove-Item Env:WEBSCRAPER_HOME

# 2. Self-test the update swap script (including rollback) on real Windows.
& $py -c "import sys; sys.path.insert(0,'packaging/desktop'); import desktop_update as u; open(r'$tmp\apply-update.ps1','w',encoding='utf-8').write(u.swap_script())"
function New-FakeApp($dir, $tag) {
  New-Item -ItemType Directory -Force "$dir\_internal" | Out-Null
  Set-Content "$dir\Webscraper.exe" $tag
  Set-Content "$dir\_internal\lib.dll" $tag
}
$inst = Join-Path $tmp 'swap-install'; $new = Join-Path $tmp 'swap-new\Webscraper'
Remove-Item $inst, (Split-Path $new -Parent) -Recurse -Force -ErrorAction SilentlyContinue
New-FakeApp $inst 'old'; New-FakeApp $new 'new'
New-Item -ItemType Directory -Force "$inst\data" | Out-Null; Set-Content "$inst\data\.env" 'KEEP=1'
powershell -NoProfile -ExecutionPolicy Bypass -File "$tmp\apply-update.ps1" -ProcId 999999 -Src $new -Dst $inst -Log "$tmp\swap.log" -NoStart
if ((Get-Content "$inst\Webscraper.exe") -ne 'new' -or (Get-Content "$inst\_internal\lib.dll") -ne 'new') { throw 'update swap did not replace program files' }
if ((Get-Content "$inst\data\.env") -ne 'KEEP=1') { throw 'update swap touched the data folder' }
if (Test-Path "$inst\_internal.old") { throw 'update swap left _internal.old behind' }
Write-Host 'update swap self-test passed'

# 3. SHA256SUMS + Setup.exe
$zip = 'Webscraper-windows-x64-portable.zip'
if (-not (Test-Path "dist\$zip")) { throw "$zip was not built" }

$iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
  foreach ($candidate in "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") {
    if (Test-Path $candidate) { $iscc = $candidate; break }
  }
}
if (-not $iscc) {
  choco install innosetup -y --no-progress | Out-Host
  $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
}
$version = (Get-Content (Join-Path $root 'packaging\desktop\stage\VERSION')).Trim()
& $iscc "/DVersion=$version" "/DSourceDir=$root\dist\release" (Join-Path $root 'packaging\desktop\installer.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed' }
if (-not (Test-Path 'dist\Webscraper-Setup.exe')) { throw 'Webscraper-Setup.exe was not built' }

# The installer must unpack a working app: install silently, then smoke test it.
$target = Join-Path $tmp 'installed'
Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
$i = Start-Process -FilePath 'dist\Webscraper-Setup.exe' -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORUN', "/DIR=$target" -Wait -PassThru
if ($i.ExitCode -ne 0) { throw "installer failed (exit $($i.ExitCode))" }
$env:WEBSCRAPER_HOME = Join-Path $tmp 'webscraper-smoke2'
$p = Start-Process -FilePath (Join-Path $target 'Webscraper.exe') -ArgumentList '--smoke-test' -Wait -PassThru -NoNewWindow
if ($p.ExitCode -ne 0) { throw "installed app smoke test failed (exit $($p.ExitCode))" }
Remove-Item Env:WEBSCRAPER_HOME

$lines = foreach ($f in $zip, 'Webscraper-Setup.exe') {
  $h = (Get-FileHash "dist\$f" -Algorithm SHA256).Hash.ToLower()
  "$h  $f"
}
Set-Content -Path 'dist\SHA256SUMS.txt' -Value $lines -Encoding ascii
Get-Content 'dist\SHA256SUMS.txt'
Write-Host 'Built: dist\Webscraper\ (portable folder), dist\Webscraper-windows-x64-portable.zip, dist\Webscraper-Setup.exe'
