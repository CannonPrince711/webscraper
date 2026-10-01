"""Loopback control API the dashboard uses to drive the launcher.

Bound to 127.0.0.1 on a random port and guarded by a random per-run token that
only the dashboard's server process receives (``DESKTOP_CONTROL_TOKEN``), so a
web page in your browser cannot call it even though it can reach loopback.
"""

from __future__ import annotations

import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Protocol


class Controller(Protocol):
    def status(self) -> dict: ...
    def check_update(self) -> dict: ...
    def install_update(self) -> dict: ...
    def request_restart(self) -> None: ...
    def request_shutdown(self) -> None: ...


def serve(controller: Controller, token: str) -> tuple[ThreadingHTTPServer, int]:
    routes: dict[tuple[str, str], Callable[[], dict]] = {
        ("GET", "/status"): controller.status,
        ("POST", "/update/check"): controller.check_update,
        ("POST", "/update/install"): controller.install_update,
        ("POST", "/restart"): lambda: (controller.request_restart(), {"ok": True})[1],
        ("POST", "/shutdown"): lambda: (controller.request_shutdown(), {"ok": True})[1],
    }

    class Handler(BaseHTTPRequestHandler):
        def _handle(self, method: str) -> None:
            supplied = self.headers.get("x-control-token", "")
            if not hmac.compare_digest(supplied, token):
                self._send(403, {"error": "forbidden"})
                return
            handler = routes.get((method, self.path.split("?")[0]))
            if handler is None:
                self._send(404, {"error": "not found"})
                return
            try:
                self._send(200, handler())
            except Exception as exc:  # report, never crash the launcher
                self._send(500, {"error": type(exc).__name__})

        def _send(self, status: int, body: dict) -> None:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:  # noqa: N802
            self._handle("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._handle("POST")

        def log_message(self, *_args) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, name="control", daemon=True).start()
    return server, server.server_address[1]
