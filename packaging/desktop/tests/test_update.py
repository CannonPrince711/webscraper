import hashlib
import http.server
import json
import threading
import zipfile
from pathlib import Path

import pytest

import desktop_update as du


def test_version_parsing_and_comparison():
    assert du.parse_version("v1.2.3") == (1, 2, 3)
    assert du.parse_version("0.2") == (0, 2)
    assert du.parse_version("nightly") is None
    assert du.is_newer("v0.2.0", "0.1.0")
    assert du.is_newer("0.10.0", "0.9.9")
    assert not du.is_newer("0.1.0", "0.1.0")
    assert not du.is_newer("0.1", "0.1.0")
    assert not du.is_newer("garbage", "0.1.0")


def test_expected_sha256_parsing():
    digest = "a" * 64
    assert du.expected_sha256(f"{digest}  {du.ASSET_NAME}\n", du.ASSET_NAME) == digest
    assert du.expected_sha256(f"{digest.upper()} *{du.ASSET_NAME}", du.ASSET_NAME) == digest
    with pytest.raises(du.UpdateError):
        du.expected_sha256(f"{digest}  other.zip", du.ASSET_NAME)


def make_zip(path: Path, *, evil: bool = False, valid: bool = True) -> None:
    with zipfile.ZipFile(path, "w") as z:
        if evil:
            z.writestr("../escape.txt", "x")
        if valid:
            z.writestr("Webscraper/Webscraper.exe", "exe")
            z.writestr("Webscraper/_internal/lib.dll", "dll")


def test_stage_accepts_a_real_build_and_rejects_others(tmp_path):
    good = tmp_path / "good.zip"
    make_zip(good)
    app = du.stage(good, tmp_path / "stage")
    assert (app / "Webscraper.exe").exists()

    bad = tmp_path / "bad.zip"
    make_zip(bad, valid=False)
    with pytest.raises(du.UpdateError):
        du.stage(bad, tmp_path / "stage2")

    evil = tmp_path / "evil.zip"
    make_zip(evil, evil=True)
    with pytest.raises(du.UpdateError, match="unsafe"):
        du.stage(evil, tmp_path / "stage3")
    assert not (tmp_path / "escape.txt").exists()


@pytest.fixture()
def release_server(tmp_path, monkeypatch):
    """A local stand-in for the GitHub API + asset host."""
    site = tmp_path / "site"
    site.mkdir()
    zip_path = site / du.ASSET_NAME
    make_zip(zip_path)
    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    (site / du.SUMS_NAME).write_text(f"{digest}  {du.ASSET_NAME}\n")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(site), **k)

        def do_GET(self):
            if self.path.endswith("/releases/latest"):
                base = f"http://127.0.0.1:{server.server_port}"
                body = json.dumps({
                    "tag_name": "v9.9.9",
                    "html_url": f"{base}/notes",
                    "assets": [
                        {"name": du.ASSET_NAME, "browser_download_url": f"{base}/{du.ASSET_NAME}"},
                        {"name": du.SUMS_NAME, "browser_download_url": f"{base}/{du.SUMS_NAME}"},
                    ],
                }).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                super().do_GET()

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("WEBSCRAPER_UPDATE_API", base)
    monkeypatch.setenv("WEBSCRAPER_UPDATE_ALLOW_PREFIX", base)
    yield site
    server.shutdown()


def test_full_download_verify_stage(release_server, tmp_path):
    info = du.latest_release()
    assert info and info.version == "9.9.9"
    zip_path = du.download_and_verify(info, tmp_path / "dl")
    assert du.stage(zip_path, tmp_path / "stage").is_dir()


def test_tampered_download_is_rejected_and_deleted(release_server, tmp_path):
    info = du.latest_release()
    (release_server / du.ASSET_NAME).write_bytes(b"tampered")
    with pytest.raises(du.UpdateError, match="checksum"):
        du.download_and_verify(info, tmp_path / "dl")
    assert not list((tmp_path / "dl").glob("*.zip"))


def test_untrusted_download_host_is_refused(monkeypatch):
    monkeypatch.delenv("WEBSCRAPER_UPDATE_ALLOW_PREFIX", raising=False)
    assert not du._trusted_download_url("https://evil.example/releases/download/x.zip")
    assert du._trusted_download_url(f"https://github.com/{du.DEFAULT_REPO}/releases/download/v1/x.zip")
    assert not du._trusted_download_url(f"http://github.com/{du.DEFAULT_REPO}/releases/download/v1/x.zip")


def test_no_release_published_is_not_an_error(monkeypatch):
    class Gone(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(404)
            self.end_headers()

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Gone)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("WEBSCRAPER_UPDATE_API", f"http://127.0.0.1:{server.server_port}")
    try:
        assert du.latest_release() is None
    finally:
        server.shutdown()
