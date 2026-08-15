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


def test_result_dict_403_step1_retries(monkeypatch):
    """run_registration 把 403 转成失败 dict 返回（不抛异常），步骤1 的 403 也要换代理重试。"""
    import core.proxy_pool as pp

    attempts = []

    def fake_run(email, name, birthday, proxy=None):
        attempts.append(proxy)
        if len(attempts) < 3:
            return {"success": False, "email": email, "error": "HTTP Error 403: ", "step": "step1_providers"}
        return {"success": True, "email": email}

    monkeypatch.setattr(pp, "pick_proxy", lambda: f"proxy-{len(attempts) + 1}")
    blacklisted = []
    monkeypatch.setattr(pp, "blacklist_proxy", lambda url, ttl=600: blacklisted.append(url))

    res = svc._run_registration_with_retry(fake_run, "a@b.com", "N", "2000-01-01")
    assert res == {"success": True, "email": "a@b.com"}
    assert attempts == ["proxy-1", "proxy-2", "proxy-3"]
    assert blacklisted == ["proxy-1", "proxy-2"]


def test_result_dict_403_later_step_no_retry(monkeypatch):
    """流程后段（账号已创建风险）的 403 不重试，直接返回失败结果。"""
    import core.proxy_pool as pp

    attempts = []

    def fake_run(email, name, birthday, proxy=None):
        attempts.append(proxy)
        return {"success": False, "email": email, "error": "HTTP Error 403: ", "step": "flow"}

    monkeypatch.setattr(pp, "pick_proxy", lambda: "p1")
    blacklisted = []
    monkeypatch.setattr(pp, "blacklist_proxy", lambda url, ttl=600: blacklisted.append(url))

    res = svc._run_registration_with_retry(fake_run, "a@b.com", "N", "2000-01-01")
    assert res["success"] is False
    assert attempts == ["p1"]
    assert blacklisted == []


def test_result_dict_non_403_step1_no_retry(monkeypatch):
    import core.proxy_pool as pp

    attempts = []

    def fake_run(email, name, birthday, proxy=None):
        attempts.append(proxy)
        return {"success": False, "email": email, "error": "timed out", "step": "step1_providers"}

    monkeypatch.setattr(pp, "pick_proxy", lambda: "p1")
    blacklisted = []
    monkeypatch.setattr(pp, "blacklist_proxy", lambda url, ttl=600: blacklisted.append(url))

    res = svc._run_registration_with_retry(fake_run, "a@b.com", "N", "2000-01-01")
    assert res["success"] is False
    assert attempts == ["p1"]
    assert blacklisted == []
