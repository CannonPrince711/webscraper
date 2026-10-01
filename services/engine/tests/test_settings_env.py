"""Environment-variable wiring for the engine's settings.

These guard a class of bug that is invisible until someone changes a knob and
nothing happens: the field names and the *documented* variable names drifted
apart, and pydantic-settings accepted the documented spelling without applying
it. Anything in `.env.example` must have a test here.
"""

from __future__ import annotations

import pytest

from app.config import Settings


def build(monkeypatch, **env: str) -> Settings:
    """A Settings instance built from an explicit environment, ignoring `.env`."""
    for key in (
        "ENGINE_ENABLE_BROWSER",
        "ENGINE_RESPECT_ROBOTS",
        "ENGINE_MAX_CONCURRENCY",
        "ENGINE_REQUEST_TIMEOUT_MS",
        "ENGINE_PROXY_URLS",
        "ENABLE_BROWSER",
        "RESPECT_ROBOTS",
        "MAX_CONCURRENCY",
        "PROXY_URLS",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return Settings(_env_file=None)  # type: ignore[call-arg]


def test_documented_engine_prefixed_names_take_effect(monkeypatch) -> None:
    settings = build(
        monkeypatch,
        ENGINE_ENABLE_BROWSER="false",
        ENGINE_RESPECT_ROBOTS="false",
        ENGINE_MAX_CONCURRENCY="3",
        ENGINE_REQUEST_TIMEOUT_MS="45000",
    )

    assert settings.enable_browser is False
    assert settings.respect_robots is False
    assert settings.max_concurrency == 3
    assert settings.request_timeout_ms == 45_000


def test_bare_field_names_still_work(monkeypatch) -> None:
    settings = build(monkeypatch, ENABLE_BROWSER="0", MAX_CONCURRENCY="2")

    assert settings.enable_browser is False
    assert settings.max_concurrency == 2


def test_proxy_pool_accepts_the_documented_csv_form(monkeypatch) -> None:
    settings = build(monkeypatch, ENGINE_PROXY_URLS="http://a:3128, http://b:3128")

    assert settings.proxy_urls == ["http://a:3128", "http://b:3128"]


def test_empty_proxy_pool_is_not_a_parse_error(monkeypatch) -> None:
    # `.env.example` ships `ENGINE_PROXY_URLS=` — an empty value must mean
    # "no pool", not "startup crash".
    assert build(monkeypatch, ENGINE_PROXY_URLS="").proxy_urls == []


@pytest.mark.parametrize("value", ["[80, 443]", "80,443"])
def test_allowed_ports_accept_json_and_csv(monkeypatch, value: str) -> None:
    settings = build(monkeypatch)
    settings = Settings(_env_file=None, allowed_ports=value)  # type: ignore[call-arg]
    assert settings.allowed_ports == [80, 443]
