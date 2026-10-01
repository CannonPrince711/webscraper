"""Self-update from GitHub Releases for the portable Windows build.

Flow: ask the Releases API for the latest release, compare it with the bundled
VERSION, download ``Webscraper-windows-x64-portable.zip``, verify its SHA-256
against the release's ``SHA256SUMS.txt``, unpack it beside the app, then hand
over to a short PowerShell script that waits for this process to exit, swaps
the program files and relaunches. ``data/`` is never part of the swap, so
settings, secrets and scraped data survive every update.

The checksum protects against truncated or corrupted downloads and against a
swapped asset on a CDN; it is published by the same release, so it does not
defend against a compromised release. Downloads are limited to the project's
own ``github.com/<repo>/releases/download/`` URLs over HTTPS.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

DEFAULT_REPO = "CannonPrince711/webscraper"
ASSET_NAME = "Webscraper-windows-x64-portable.zip"
SUMS_NAME = "SHA256SUMS.txt"
MAX_ZIP_BYTES = 1024 * 1024 * 1024  # refuse absurd downloads


class UpdateError(Exception):
    """A user-presentable failure (no stack trace needed in the UI)."""


def repo() -> str:
    return os.environ.get("WEBSCRAPER_UPDATE_REPO", DEFAULT_REPO)


def api_base() -> str:
    return os.environ.get("WEBSCRAPER_UPDATE_API", "https://api.github.com").rstrip("/")


def parse_version(text: str) -> tuple[int, ...] | None:
    """``v1.2.3`` / ``1.2`` -> ``(1, 2, 3)``; ``None`` for anything else."""
    match = re.fullmatch(r"v?(\d+(?:\.\d+){0,3})", text.strip())
    if not match:
        return None
    return tuple(int(part) for part in match.group(1).split("."))


def is_newer(latest: str, current: str) -> bool:
    a, b = parse_version(latest), parse_version(current)
    if a is None or b is None:
        return False
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


@dataclass
class ReleaseInfo:
    tag: str
    version: str
    asset_url: str
    sums_url: str
    notes_url: str


def _get(url: str, timeout: float = 15) -> bytes:
    request = urllib.request.Request(  # noqa: S310 - https only, validated by callers
        url, headers={"User-Agent": "Webscraper-updater", "Accept": "application/vnd.github+json"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        return response.read()


def _trusted_download_url(url: str) -> bool:
    allowed = os.environ.get("WEBSCRAPER_UPDATE_ALLOW_PREFIX")  # tests only
    if allowed and url.startswith(allowed):
        return True
    return url.startswith(f"https://github.com/{repo()}/releases/download/")


def latest_release(timeout: float = 15) -> ReleaseInfo | None:
    """The newest published release, or ``None`` when it has no portable build."""
    try:
        payload = json.loads(_get(f"{api_base()}/repos/{repo()}/releases/latest", timeout))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None  # no release published yet
        raise UpdateError(f"GitHub Releases returned HTTP {exc.code}.") from exc
    except Exception as exc:  # network down, bad JSON
        raise UpdateError(f"Could not reach GitHub Releases ({type(exc).__name__}).") from exc

    tag = str(payload.get("tag_name", ""))
    version = parse_version(tag)
    if version is None:
        return None
    assets = {a.get("name"): a.get("browser_download_url", "") for a in payload.get("assets", [])}
    if ASSET_NAME not in assets or SUMS_NAME not in assets:
        return None
    for url in (assets[ASSET_NAME], assets[SUMS_NAME]):
        if not _trusted_download_url(url):
            raise UpdateError("The release points at an unexpected download location; refusing it.")
    return ReleaseInfo(
        tag=tag,
        version=".".join(str(p) for p in version),
        asset_url=assets[ASSET_NAME],
        sums_url=assets[SUMS_NAME],
        notes_url=str(payload.get("html_url", "")),
    )


def expected_sha256(sums_text: str, name: str) -> str:
    """Parse ``<hash>  <name>`` lines (sha256sum / PowerShell Get-FileHash style)."""
    for line in sums_text.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and parts[-1].lstrip("*") == name and re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
            return parts[0].lower()
    raise UpdateError(f"{SUMS_NAME} has no checksum for {name}.")


def download_and_verify(info: ReleaseInfo, dest_dir: Path, timeout: float = 60) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    expected = expected_sha256(_get(info.sums_url, timeout).decode("utf-8", "replace"), ASSET_NAME)

    target = dest_dir / f"{info.version}-{ASSET_NAME}"
    digest = hashlib.sha256()
    request = urllib.request.Request(info.asset_url, headers={"User-Agent": "Webscraper-updater"})  # noqa: S310
    total = 0
    with urllib.request.urlopen(request, timeout=timeout) as response, target.open("wb") as out:  # noqa: S310
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_ZIP_BYTES:
                raise UpdateError("The update download is unexpectedly large; aborting.")
            digest.update(chunk)
            out.write(chunk)
    if digest.hexdigest() != expected:
        target.unlink(missing_ok=True)
        raise UpdateError("The downloaded update failed its checksum and was discarded.")
    return target


def stage(zip_path: Path, dest: Path) -> Path:
    """Unpack the verified zip; returns the folder that holds ``Webscraper.exe``."""
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True)
    root = dest.resolve()
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            target = (root / member.filename).resolve()
            if root != target and root not in target.parents:  # zip-slip
                raise UpdateError("The update archive contains an unsafe path; aborting.")
        archive.extractall(root)
    app = root / "Webscraper"
    if not (app / "Webscraper.exe").exists() or not (app / "_internal").is_dir():
        raise UpdateError("The update archive does not look like a Webscraper build.")
    return app


_SWAP_SCRIPT = r"""
param([int]$ProcId, [string]$Src, [string]$Dst, [string]$Log, [switch]$NoStart)
$ErrorActionPreference = 'Stop'
function Log($m) { Add-Content -Path $Log -Value ("{0} {1}" -f (Get-Date -Format s), $m) }
try {
  Log "waiting for process $ProcId"
  try { Wait-Process -Id $ProcId -Timeout 90 } catch {}
  Start-Sleep -Milliseconds 800
  $old = Join-Path $Dst '_internal.old'
  if (Test-Path $old) { Remove-Item $old -Recurse -Force }
  Rename-Item (Join-Path $Dst '_internal') '_internal.old'
  if (Test-Path (Join-Path $Dst 'Webscraper.exe.old')) { Remove-Item (Join-Path $Dst 'Webscraper.exe.old') -Force }
  Rename-Item (Join-Path $Dst 'Webscraper.exe') 'Webscraper.exe.old'
  try {
    Copy-Item (Join-Path $Src '_internal') $Dst -Recurse -Force
    Copy-Item (Join-Path $Src 'Webscraper.exe') $Dst -Force
    foreach ($extra in 'README-PORTABLE.txt') {
      if (Test-Path (Join-Path $Src $extra)) { Copy-Item (Join-Path $Src $extra) $Dst -Force }
    }
  } catch {
    Log "copy failed, rolling back: $_"
    if (Test-Path (Join-Path $Dst '_internal')) { Remove-Item (Join-Path $Dst '_internal') -Recurse -Force }
    if (Test-Path (Join-Path $Dst 'Webscraper.exe')) { Remove-Item (Join-Path $Dst 'Webscraper.exe') -Force }
    Rename-Item $old '_internal'
    Rename-Item (Join-Path $Dst 'Webscraper.exe.old') 'Webscraper.exe'
    throw
  }
  Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Dst 'Webscraper.exe.old') -Force -ErrorAction SilentlyContinue
  Remove-Item (Split-Path $Src -Parent) -Recurse -Force -ErrorAction SilentlyContinue
  Log "update applied"
} catch {
  Log "update failed: $_"
}
if (-not $NoStart) {
  Start-Process -FilePath (Join-Path $Dst 'Webscraper.exe') -ArgumentList '--restarted' -WorkingDirectory $Dst
}
"""


def swap_script() -> str:
    """The PowerShell used to replace program files (exposed for CI self-tests)."""
    return _SWAP_SCRIPT


def can_self_update(install_dir: Path) -> bool:
    """Only the frozen Windows build, in a folder we can write to."""
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return False
    probe = install_dir / ".write-test"
    try:
        probe.write_text("x")
        probe.unlink()
        return True
    except OSError:
        return False


def apply_and_relaunch(staged_app: Path, install_dir: Path, log: Path) -> None:
    """Spawn the swap script. The caller must exit promptly afterwards."""
    if os.name != "nt":
        raise UpdateError("Applying updates in place is only supported on Windows.")
    script = install_dir / "updates" / "apply-update.ps1"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(swap_script(), encoding="utf-8")
    flags = (
        getattr(subprocess, "DETACHED_PROCESS", 0)
        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    )
    subprocess.Popen(  # noqa: S603 - fixed argv
        [
            "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script),
            "-ProcId", str(os.getpid()), "-Src", str(staged_app), "-Dst", str(install_dir), "-Log", str(log),
        ],
        creationflags=flags,
        close_fds=True,
    )
