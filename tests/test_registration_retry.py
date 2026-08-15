# -*- coding: utf-8 -*-
"""注册任务 403（出口 IP 被封）自动换代理重试。"""
import pytest

from core import registration_service as svc


def test_retry_switches_proxy_on_403(monkeypatch):
    import core.proxy_pool as pp

    attempts = []

    def fake_run(email, name, birthday, proxy=None):
        attempts.append(proxy)
        if len(attempts) < 3:
            raise RuntimeError("HTTP Error 403: ")
        return {"success": True, "email": email}

    monkeypatch.setattr(pp, "pick_proxy", lambda: f"proxy-{len(attempts) + 1}")
    blacklisted = []
    monkeypatch.setattr(pp, "blacklist_proxy", lambda url, ttl=600: blacklisted.append(url))

    res = svc._run_registration_with_retry(fake_run, "a@b.com", "N", "2000-01-01")
    assert res == {"success": True, "email": "a@b.com"}
    assert attempts == ["proxy-1", "proxy-2", "proxy-3"]
    assert blacklisted == ["proxy-1", "proxy-2"]


def test_retry_exhausts_all_403(monkeypatch):
    import core.proxy_pool as pp

    attempts = []

    def fake_run(email, name, birthday, proxy=None):
        attempts.append(proxy)
        raise RuntimeError("HTTP Error 403: ")

    monkeypatch.setattr(pp, "pick_proxy", lambda: f"proxy-{len(attempts) + 1}")
    blacklisted = []
    monkeypatch.setattr(pp, "blacklist_proxy", lambda url, ttl=600: blacklisted.append(url))

    with pytest.raises(RuntimeError, match="HTTP Error 403"):
        svc._run_registration_with_retry(fake_run, "a@b.com", "N", "2000-01-01")
    assert len(attempts) == svc._PROXY_403_RETRIES
    assert len(blacklisted) == svc._PROXY_403_RETRIES - 1


def test_no_retry_on_non_403(monkeypatch):
    import core.proxy_pool as pp

    attempts = []

    def fake_run(email, name, birthday, proxy=None):
        attempts.append(proxy)
        raise RuntimeError("network down")

    monkeypatch.setattr(pp, "pick_proxy", lambda: "p1")
    blacklisted = []
    monkeypatch.setattr(pp, "blacklist_proxy", lambda url, ttl=600: blacklisted.append(url))

    with pytest.raises(RuntimeError, match="network down"):
        svc._run_registration_with_retry(fake_run, "a@b.com", "N", "2000-01-01")
    assert len(attempts) == 1
    assert blacklisted == []
