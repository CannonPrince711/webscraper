"""Webscraper desktop launcher (the entry point frozen into Webscraper.exe).

One portable folder, two servers, zero configuration:

* the FastAPI scraping engine runs in-process on a loopback port, and
* the Next.js dashboard runs as a child ``node`` process from the bundled
  standalone build.

Everything binds to 127.0.0.1 only. Frozen builds are *portable*: all state
(the local JSON store, generated secrets, the ``.env`` edited from Settings)
lives in ``data/`` next to ``Webscraper.exe``, so the folder can be moved, zipped
or deleted as a unit and updates never touch it. If that folder is read-only
(e.g. Program Files) it falls back to ``%LOCALAPPDATA%\\Webscraper``.

``--smoke-test`` boots both servers, checks they answer, and exits non-zero if
they do not; CI uses it to verify the frozen binary.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

import control
import desktop_update as du

APP_NAME = "Webscraper"
UPDATE_CHECK_INTERVAL = 6 * 3600
# Snapshot before we add anything, so a restart re-reads .env from scratch
# instead of inheriting values loaded from the previous run's file.
ORIGINAL_ENV = dict(os.environ)


# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------
def bundle_dir() -> Path:
    """Where PyInstaller put our data files (or this folder when unfrozen)."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent / "_internal"))
    return Path(__file__).parent


def install_dir() -> Path:
    return Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent


def _writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write-test"
        probe.write_text("x")
        probe.unlink()
        return True
    except OSError:
        return False


def data_dir() -> Path:
    override = os.environ.get("WEBSCRAPER_HOME")
    if override:
        base = Path(override)
        base.mkdir(parents=True, exist_ok=True)
        return base
    if getattr(sys, "frozen", False):
        portable = install_dir() / "data"
        if _writable(portable):
            return portable
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / APP_NAME
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / APP_NAME.lower()
    base.mkdir(parents=True, exist_ok=True)
    return base


def app_version() -> str:
    try:
        return (bundle_dir() / "VERSION").read_text(encoding="utf-8").strip() or "0.0.0"
    except OSError:
        return "0.0.0"


# --------------------------------------------------------------------------
# Environment
# --------------------------------------------------------------------------
def load_env_file(path: Path) -> None:
    """Minimal KEY=VALUE parser; real environment variables always win."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
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


def truthy(value: str | None, default: bool) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


# --------------------------------------------------------------------------
# Processes
# --------------------------------------------------------------------------
def free_port(preferred: int, wait: float = 0) -> int:
    """The preferred port if free (waiting up to ``wait`` s), else any free one."""
    deadline = time.monotonic() + wait
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", preferred))
                return sock.getsockname()[1]
            except OSError:
                pass
        if time.monotonic() >= deadline:
            break
        time.sleep(0.4)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


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
    return str(exe) if exe.exists() else "node"  # unfrozen / development fallback


def start_engine(port: int):
    import uvicorn

    from app.main import app  # imported late so env vars are already in place

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, name="engine", daemon=True).start()
    return server


def start_web(port: int, engine_port: int, home: Path, control_port: int, control_token: str) -> subprocess.Popen:
    web_root = bundle_dir() / "web" / "app"
    # Next's standalone output mirrors the monorepo layout under the tracing root.
    server_js = web_root / "apps" / "web" / "server.js"
    if not server_js.exists():
        raise RuntimeError(f"bundled dashboard not found under {web_root}")

    env = dict(os.environ)
    env.update(
        NODE_ENV="production",
        WEBSCRAPER_DESKTOP="1",
        WEBSCRAPER_HOME=str(home),
        HOSTNAME="127.0.0.1",
        PORT=str(port),
        APP_URL=f"http://127.0.0.1:{port}",
        ENGINE_URL=f"http://127.0.0.1:{engine_port}",
        DEMO_DATA_DIR=str(home / "store"),
        DESKTOP_CONTROL_URL=f"http://127.0.0.1:{control_port}",
        DESKTOP_CONTROL_TOKEN=control_token,
    )
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.Popen(  # noqa: S603 - fixed argv, bundled binary
        [node_executable(), str(server_js)], cwd=str(server_js.parent), env=env, creationflags=flags
    )


# --------------------------------------------------------------------------
# Controller: state shared with the dashboard through control.py
# --------------------------------------------------------------------------
class App:
    def __init__(self, home: Path) -> None:
        self.home = home
        self.version = app_version()
        self.stop = threading.Event()
        self.mode = "run"  # run | restart | shutdown | update
        self.staged: Path | None = None
        self._lock = threading.Lock()
        self.update: dict = {"state": "idle", "latest": None, "notesUrl": None, "message": None, "checkedAt": None}
        self._info: du.ReleaseInfo | None = None

    # -- Controller protocol ------------------------------------------------
    def status(self) -> dict:
        return {
            "version": self.version,
            "dataDir": str(self.home),
            "portable": getattr(sys, "frozen", False),
            "canSelfUpdate": du.can_self_update(install_dir()),
            "update": dict(self.update),
        }

    def check_update(self) -> dict:
        with self._lock:
            self._set(state="checking", message=None)
            try:
                info = du.latest_release()
            except du.UpdateError as exc:
                self._set(state="error", message=str(exc))
                return self.status()
            stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
            if info is None or not du.is_newer(info.version, self.version):
                self._info = None
                self._set(state="up-to-date", latest=info.version if info else None, notesUrl=None,
                          message="You are on the latest version.", checkedAt=stamp)
            else:
                self._info = info
                self._set(state="available", latest=info.version, notesUrl=info.notes_url,
                          message=None, checkedAt=stamp)
            return self.status()

    def install_update(self) -> dict:
        with self._lock:
            if self._info is None:
                raise RuntimeError("no update available")
            if not du.can_self_update(install_dir()):
                self._set(state="error", message="This copy cannot update itself in place.")
                return self.status()
            try:
                self._set(state="downloading", message="Downloading and verifying the update…")
                archive = du.download_and_verify(self._info, install_dir() / "updates")
                self.staged = du.stage(archive, install_dir() / "updates" / "staged" / self._info.version)
            except (du.UpdateError, OSError) as exc:
                self._set(state="error", message=str(exc))
                return self.status()
            self._set(state="installing", message="Restarting to finish the update…")
        self.mode = "update"
        self.stop.set()
        return self.status()

    def request_restart(self) -> None:
        self.mode = "restart"
        self.stop.set()

    def request_shutdown(self) -> None:
        self.mode = "shutdown"
        self.stop.set()

    def _set(self, **changes) -> None:
        self.update.update(changes)


def auto_update_at_startup(app: App) -> bool:
    """Install a newer release before the servers start. True = exiting to update."""
    if not du.can_self_update(install_dir()):
        return False
    if not truthy(os.environ.get("WEBSCRAPER_AUTO_UPDATE"), True):
        return False
    print(f"{APP_NAME}: checking for updates ...")
    status = app.check_update()
    if status["update"]["state"] != "available":
        return False
    print(f"{APP_NAME}: installing v{status['update']['latest']} ...")
    app.install_update()
    return app.mode == "update"


def background_update_checks(app: App) -> None:
    while not app.stop.wait(UPDATE_CHECK_INTERVAL):
        try:
            app.check_update()
        except Exception:
            pass


def respawn(restarted: bool = True) -> None:
    argv = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, str(Path(__file__).resolve())]
    argv += [a for a in sys.argv[1:] if a not in {"--restarted", "--smoke-test"}]
    if restarted:
        argv.append("--restarted")
    flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0) if os.name == "nt" else 0
    subprocess.Popen(argv, env=ORIGINAL_ENV, creationflags=flags, close_fds=True)  # noqa: S603


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def main() -> int:
    smoke = "--smoke-test" in sys.argv
    restarted = "--restarted" in sys.argv
    home = data_dir()
    (home / "store").mkdir(exist_ok=True)

    load_env_file(home / ".env")
    app = App(home)
    print(f"{APP_NAME} v{app.version}")
    print(f"{APP_NAME}: data folder  {home}")

    if not smoke and auto_update_at_startup(app):
        du.apply_and_relaunch(app.staged, install_dir(), home / "update.log")
        return 0

    os.environ.setdefault("APP_SECRET", persistent_secret(home, "app"))
    engine_key = os.environ.setdefault("ENGINE_API_KEY", persistent_secret(home, "engine"))
    # The bundle does not ship Chromium; enable it via Settings if you install
    # Playwright's browser yourself.
    os.environ.setdefault("ENGINE_ENABLE_BROWSER", "false")
    os.environ.setdefault("ENGINE_ENVIRONMENT", "development")
    os.environ["ENGINE_API_KEY"] = engine_key

    wait = 20 if restarted else 0  # the previous instance may still hold the port
    engine_port = free_port(int(os.environ.get("ENGINE_PORT", "8000")), wait)
    web_port = free_port(int(os.environ.get("PORT", "3000")), wait)
    os.environ["ENGINE_URL"] = f"http://127.0.0.1:{engine_port}"

    sys.path.insert(0, str(bundle_dir() / "engine"))
    print(f"{APP_NAME}: starting engine on :{engine_port} ...")
    start_engine(engine_port)
    if not wait_for(f"http://127.0.0.1:{engine_port}/healthz", 60):
        print("The scraping engine did not start.", file=sys.stderr)
        return 1

    token = secrets.token_urlsafe(32)
    control_server, control_port = control.serve(app, token)

    print(f"{APP_NAME}: starting dashboard on :{web_port} ...")
    web = start_web(web_port, engine_port, home, control_port, token)
    try:
        if not wait_for(f"http://127.0.0.1:{web_port}/api/health", 90, web):
            print(f"The dashboard did not start (node exit code: {web.poll()}).", file=sys.stderr)
            return 1
        url = f"http://127.0.0.1:{web_port}"
        if smoke:
            return run_smoke_checks(url, app, token, control_port)

        print(f"{APP_NAME}: ready at {url}")
        print(f"{APP_NAME}: use the Stop button in the app (or close this window) to quit.")
        if not restarted and truthy(os.environ.get("WEBSCRAPER_OPEN_BROWSER"), True):
            webbrowser.open(url)
        threading.Thread(target=background_update_checks, args=(app,), daemon=True).start()

        while not app.stop.is_set():
            if web.poll() is not None:  # dashboard died on its own
                app.mode = "shutdown"
                break
            app.stop.wait(0.5)
        return 0
    except KeyboardInterrupt:
        app.mode = "shutdown"
        return 0
    finally:
        # Let the HTTP response that triggered stop/restart flush first.
        time.sleep(0.6)
        control_server.shutdown()
        if web.poll() is None:
            web.terminate()
            try:
                web.wait(timeout=5)
            except subprocess.TimeoutExpired:
                web.kill()
        if app.mode == "restart":
            print(f"{APP_NAME}: restarting ...")
            respawn()
        elif app.mode == "update" and app.staged is not None:
            du.apply_and_relaunch(app.staged, install_dir(), home / "update.log")
        else:
            print(f"{APP_NAME}: stopped.")


def run_smoke_checks(url: str, app: App, token: str, control_port: int) -> int:
    """Verify the pieces actually talk to each other, not just that they boot."""
    with urllib.request.urlopen(f"{url}/api/health", timeout=10) as response:  # noqa: S310
        report = json.load(response)
    payload = report.get("data", report)
    if (payload.get("engine") or {}).get("status") != "ok":
        print(f"Dashboard cannot reach the engine: {report}", file=sys.stderr)
        return 1

    # The control channel must reject a missing token and accept the right one.
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{control_port}/status", timeout=5)  # noqa: S310
        print("Control API answered without a token.", file=sys.stderr)
        return 1
    except urllib.error.HTTPError as exc:
        if exc.code != 403:
            print(f"Control API returned {exc.code} without a token.", file=sys.stderr)
            return 1
    request = urllib.request.Request(f"http://127.0.0.1:{control_port}/status", headers={"x-control-token": token})
    with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310
        if json.load(response).get("version") != app.version:
            print("Control API reported the wrong version.", file=sys.stderr)
            return 1

    # Settings API: reachable in desktop mode, and refuses a foreign Origin.
    with urllib.request.urlopen(f"{url}/api/settings/env", timeout=10) as response:  # noqa: S310
        names = {item["key"] for item in json.load(response)["variables"]}
    if "AI_API_KEY" not in names or "APP_SECRET" in names:
        print("Settings variables are wrong.", file=sys.stderr)
        return 1
    hostile = urllib.request.Request(
        f"{url}/api/settings/env", method="PUT", data=b'{"values":{}}',
        headers={"content-type": "application/json", "origin": "https://evil.example"},
    )
    try:
        urllib.request.urlopen(hostile, timeout=10)  # noqa: S310
        print("Settings API accepted a cross-origin write.", file=sys.stderr)
        return 1
    except urllib.error.HTTPError as exc:
        if exc.code != 403:
            print(f"Cross-origin write returned {exc.code}, expected 403.", file=sys.stderr)
            return 1

    print(f"{APP_NAME}: smoke test passed ({url})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
