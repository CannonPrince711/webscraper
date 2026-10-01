"""Build Webscraper(.exe): stage the dashboard + node, then freeze with PyInstaller.

Cross-platform on purpose (the Windows CI job and a Linux dev box run the same
steps). Run from the repo root:  python packaging/desktop/build.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
STAGE = HERE / "stage"
IS_WIN = os.name == "nt"
NPM = "npm.cmd" if IS_WIN else "npm"


def run(cmd: list[str], **kwargs) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, **kwargs)


def main() -> None:
    env = dict(os.environ, WEBSCRAPER_DESKTOP="1", NEXT_TELEMETRY_DISABLED="1")

    run([NPM, "ci"], cwd=ROOT)
    run([NPM, "--workspace", "@webscraper/shared", "run", "build"], cwd=ROOT)
    run([NPM, "--workspace", "@webscraper/web", "run", "build"], cwd=ROOT, env=env)

    web_build = ROOT / "apps" / "web" / ".next"
    standalone = web_build / "standalone"
    if not standalone.exists():
        sys.exit("next build did not produce .next/standalone")

    shutil.rmtree(STAGE, ignore_errors=True)
    app_dir = STAGE / "web" / "app"
    shutil.copytree(standalone, app_dir, symlinks=False)
    shutil.copytree(web_build / "static", app_dir / "apps" / "web" / ".next" / "static")
    public = ROOT / "apps" / "web" / "public"
    if public.exists():
        shutil.copytree(public, app_dir / "apps" / "web" / "public")

    node = shutil.which("node")
    if not node:
        sys.exit("node is not on PATH")
    shutil.copy2(node, STAGE / "web" / ("node.exe" if IS_WIN else "node"))

    sep = ";" if IS_WIN else ":"
    dist = ROOT / "dist"
    run(
        [
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
            "--name", "Webscraper",
            "--distpath", str(dist),
            "--workpath", str(HERE / "build"),
            "--specpath", str(HERE / "build"),
            "--paths", str(ROOT / "services" / "engine"),
            "--add-data", f"{STAGE / 'web'}{sep}web",
            "--hidden-import", "app.main",
            "--collect-submodules", "app",
            "--collect-submodules", "uvicorn",
            "--collect-all", "trafilatura",
            "--collect-all", "justext",
            "--collect-all", "htmldate",
            "--collect-all", "courlan",
            "--collect-all", "selectolax",
            "--exclude-module", "playwright",
            "--exclude-module", "pytest",
            str(HERE / "launcher.py"),
        ],
        cwd=ROOT,
    )
    exe = dist / ("Webscraper.exe" if IS_WIN else "Webscraper")
    print(f"built {exe} ({exe.stat().st_size / 1_048_576:.0f} MiB)")


if __name__ == "__main__":
    main()
