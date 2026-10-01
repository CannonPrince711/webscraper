"""Build Webscraper(.exe): stage the dashboard + node, then freeze with PyInstaller.

Cross-platform on purpose (the Windows CI job and a Linux dev box run the same
steps). Run from the repo root:  python packaging/desktop/build.py
"""

from __future__ import annotations

import json
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


def version() -> str:
    explicit = os.environ.get("WEBSCRAPER_VERSION", "").strip().lstrip("v")
    if explicit:
        return explicit
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]


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

    (STAGE / "VERSION").write_text(version() + "\n", encoding="utf-8")

    sep = ";" if IS_WIN else ":"
    dist = ROOT / "dist"
    run(
        [
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
            "--name", "Webscraper",
            "--distpath", str(dist),
            "--workpath", str(HERE / "build"),
            "--specpath", str(HERE / "build"),
            "--paths", str(ROOT / "services" / "engine"),
            "--add-data", f"{STAGE / 'web'}{sep}web",
            "--add-data", f"{STAGE / 'VERSION'}{sep}.",
            "--hidden-import", "app.main",
            "--hidden-import", "control",
            "--hidden-import", "desktop_update",
            "--paths", str(HERE),
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
    app_folder = dist / "Webscraper"
    exe = app_folder / ("Webscraper.exe" if IS_WIN else "Webscraper")
    if not exe.exists():
        sys.exit(f"PyInstaller did not produce {exe}")
    shutil.copy2(HERE / "README-PORTABLE.txt", app_folder / "README-PORTABLE.txt")

    # dist/release/Webscraper/...  ->  the portable zip (also the update payload)
    release = dist / "release"
    shutil.rmtree(release, ignore_errors=True)
    release.mkdir(parents=True)
    shutil.copytree(app_folder, release / "Webscraper")

    zip_name = "Webscraper-windows-x64-portable.zip" if IS_WIN else "Webscraper-linux-x64-portable.zip"
    archive = Path(shutil.make_archive(str(dist / zip_name[:-4]), "zip", root_dir=release, base_dir="Webscraper"))
    print(f"built {exe}")
    print(f"built {archive.name} ({archive.stat().st_size / 1_048_576:.0f} MiB), version {version()}")


if __name__ == "__main__":
    main()
