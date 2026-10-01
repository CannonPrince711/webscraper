"""Webscraper desktop launcher (the entry point frozen into Webscraper.exe).

One executable, two servers, zero configuration:

* the FastAPI scraping engine runs in-process on a loopback port, and
* the Next.js dashboard runs as a child ``node`` process from the bundled
  standalone build.

Everything binds to 127.0.0.1 only. Per-user data (the local JSON store, the
generated secrets, an optional ``.env`` with proxy / AI credentials) lives in
``%LOCALAPPDATA%\\Webscraper`` so upgrading the exe never touches it.

``Webscraper.exe --smoke-test`` boots both servers, checks they answer, and
exits non-zero if they do not; CI uses it to verify the frozen binary.
"""

from __future__ import annotations

import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

APP_NAME = "Webscraper"


def bundle_dir() -> Path:
    """Where PyInstaller unpacked our data files (or the repo when unfrozen)."""
    return Path(getattr(sys, "_MEIPASS", Path(__file__).parent))


def data_dir() -> Path:
    override = os.environ.get("WEBSCRAPER_HOME")
    if override:
        base = Path(override)
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / APP_NAME
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / APP_NAME.lower()
    base.mkdir(parents=True, exist_ok=True)
    return base


def load_env_file(path: Path) -> None:
    """Minimal KEY=VALUE parser; real environment variables always win."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key.strip(), value)


def persistent_secret(home: Path, name: str) -> str:
    """Generate once, reuse forever: sessions and API keys survive restarts."""
    file = home / f"{name}.secret"
    if file.exists():
        value = file.read_text(encoding="utf-8").strip()
        if len(value) >= 32:
            return value
    value = secrets.token_urlsafe(48)
    file.write_text(value, encoding="utf-8")
    return value


def free_port(preferred: int) -> int:
    for candidate in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", candidate))
            except OSError:
                continue
            return sock.getsockname()[1]
    raise RuntimeError("no free loopback port available")


def wait_for(url: str, timeout: float, proc: subprocess.Popen | None = None) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=2) as response:  # noqa: S310 - loopback only
                if response.status < 500:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def node_executable() -> str:
    exe = bundle_dir() / "web" / ("node.exe" if os.name == "nt" else "node")
    if exe.exists():
        return str(exe)
    return "node"  # unfrozen / development fallback


def start_engine(port: int) -> None:
    import uvicorn

    from app.main import app  # imported late so env vars are already in place

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, name="engine", daemon=True).start()


def start_web(port: int, engine_port: int, home: Path) -> subprocess.Popen:
    web_root = bundle_dir() / "web" / "app"
    # Next's standalone output mirrors the monorepo layout under the tracing root.
    server_js = web_root / "apps" / "web" / "server.js"
    if not server_js.exists():
        raise RuntimeError(f"bundled dashboard not found under {web_root}")

    env = dict(os.environ)
    env.update(
        NODE_ENV="production",
        WEBSCRAPER_DESKTOP="1",
        HOSTNAME="127.0.0.1",
        PORT=str(port),
        APP_URL=f"http://127.0.0.1:{port}",
        ENGINE_URL=f"http://127.0.0.1:{engine_port}",
        DEMO_DATA_DIR=str(home / "data"),
    )
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.Popen(  # noqa: S603 - fixed argv, bundled binary
        [node_executable(), str(server_js)],
        cwd=str(server_js.parent),
        env=env,
        creationflags=flags,
    )


def main() -> int:
    smoke = "--smoke-test" in sys.argv
    home = data_dir()
    (home / "data").mkdir(exist_ok=True)

    load_env_file(home / ".env")
    os.environ.setdefault("APP_SECRET", persistent_secret(home, "app"))
    engine_key = os.environ.setdefault("ENGINE_API_KEY", persistent_secret(home, "engine"))
    # The bundle does not ship Chromium; enable it explicitly via .env if you
    # install Playwright's browser yourself.
    os.environ.setdefault("ENGINE_ENABLE_BROWSER", "false")
    os.environ.setdefault("ENGINE_ENVIRONMENT", "development")
    os.environ["ENGINE_API_KEY"] = engine_key

    engine_port = free_port(int(os.environ.get("ENGINE_PORT", "8000")))
    web_port = free_port(int(os.environ.get("PORT", "3000")))
    os.environ["ENGINE_URL"] = f"http://127.0.0.1:{engine_port}"

    sys.path.insert(0, str(bundle_dir() / "engine"))
    print(f"{APP_NAME}: data folder  {home}")
    print(f"{APP_NAME}: starting engine on :{engine_port} ...")
    start_engine(engine_port)
    if not wait_for(f"http://127.0.0.1:{engine_port}/healthz", 60):
        print("The scraping engine did not start.", file=sys.stderr)
        return 1

    print(f"{APP_NAME}: starting dashboard on :{web_port} ...")
    web = start_web(web_port, engine_port, home)
    try:
        if not wait_for(f"http://127.0.0.1:{web_port}/api/health", 90, web):
            print(f"The dashboard did not start (node exit code: {web.poll()}).", file=sys.stderr)
            return 1
        url = f"http://127.0.0.1:{web_port}"
        if smoke:
            import json

            with urllib.request.urlopen(f"{url}/api/health", timeout=10) as response:  # noqa: S310
                report = json.load(response)
            payload = report.get("data", report)
            engine_status = (payload.get("engine") or {}).get("status")
            if engine_status != "ok":
                print(f"Dashboard cannot reach the engine: {report}", file=sys.stderr)
                return 1
            print(f"{APP_NAME}: smoke test passed ({url})")
            return 0
        print(f"{APP_NAME}: ready at {url}  (close this window to quit)")
        webbrowser.open(url)
        web.wait()
        return web.returncode or 0
    except KeyboardInterrupt:
        return 0
    finally:
        if web.poll() is None:
            web.terminate()
            try:
                web.wait(timeout=5)
            except subprocess.TimeoutExpired:
                web.kill()


if __name__ == "__main__":
    sys.exit(main())
