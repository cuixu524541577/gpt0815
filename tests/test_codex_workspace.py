# -*- coding: utf-8 -*-
"""Codex OAuth workspace 步骤：新账号无 workspace 时的降级路径回归测试。"""
import base64
import json

import pytest

from core import codex_oauth as co


def _b64url(obj) -> str:
    raw = json.dumps(obj).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class _Cookie:
    def __init__(self, name, value):
        self.name = name
        self.value = value


class _Jar:
    def __init__(self, cookies):
        self._cookies = cookies

    def __iter__(self):
        return iter(self._cookies)


class _Cookies:
    def __init__(self, jar):
        self.jar = jar


class _FakeSession:
    def __init__(self, cookies):
        self.session = type("S", (), {"cookies": _Cookies(_Jar(cookies))})()


def _session_with_payload(payload: dict | None):
    if payload is None:
        return _FakeSession([])
    value = _b64url(payload) + ".sig.sig"
    return _FakeSession([_Cookie("oai-client-auth-session", value)])


def test_fresh_account_returns_none():
    """新账号 cookie 里没有 workspaces → 返回 None，不抛错。"""
    s = _session_with_payload({"email": "a@b.com", "openai_client_id": "app_x"})
    assert co._get_workspace_id(s) is None


def test_existing_account_returns_workspace_id():
    s = _session_with_payload({"workspaces": [{"id": "ws-1"}]})
    assert co._get_workspace_id(s) == "ws-1"


def test_missing_cookie_raises():
    with pytest.raises(RuntimeError, match="找不到 oai-client-auth-session"):
        co._get_workspace_id(_session_with_payload(None))


def test_select_workspace_with_id_posts_select(monkeypatch):
    posts = []

    class FakeResp:
        headers = {"location": "http://localhost:1455/auth/callback?code=abc&state=s1"}

    def fake_post(session, url, payload, referer, **kw):
        posts.append((url, payload))
        return FakeResp()

    monkeypatch.setattr(co, "_get_workspace_id", lambda s: "ws-9")
    monkeypatch.setattr(co, "_post_json", fake_post)

    cb = co._select_workspace_and_get_callback(_FakeSession([]), "s1", auth_url="https://x")
    assert cb == "http://localhost:1455/auth/callback?code=abc&state=s1"
    assert posts[0][0].endswith("/api/accounts/workspace/select")
    assert posts[0][1] == {"workspace_id": "ws-9"}


def test_fresh_account_replays_auth_url_without_select(monkeypatch):
    posts = []

    def fake_post(session, url, payload, referer, **kw):
        posts.append(url)

    def fake_follow(session, url, state):
        return "http://localhost:1455/auth/callback?code=xyz&state=" + state

    monkeypatch.setattr(co, "_get_workspace_id", lambda s: None)
    monkeypatch.setattr(co, "_post_json", fake_post)
    monkeypatch.setattr(co, "_follow_until_callback", fake_follow)

    cb = co._select_workspace_and_get_callback(
        _FakeSession([]), "s1", auth_url="https://auth.openai.com/oauth/authorize?client_id=x",
    )
    assert cb.endswith("&state=s1")
    assert posts == [], "无 workspace 时不应调用 workspace/select"


def test_fresh_account_without_auth_url_raises(monkeypatch):
    monkeypatch.setattr(co, "_get_workspace_id", lambda s: None)
    with pytest.raises(RuntimeError, match="没有可重放的授权地址"):
        co._select_workspace_and_get_callback(_FakeSession([]), "s1", auth_url=None)


def test_phone_failure_reason_auth_step_invalid():
    text = "Invalid authorization step. invalid_request_error invalid_auth_step https://auth.openai.com/log-in"
    assert co._phone_failure_reason(text, 400) == "auth_step_invalid"
    assert co._phone_failure_reason("invalid_auth_step", 400) == "auth_step_invalid"
    assert co._phone_failure_reason("phone number is not valid", 400) == "invalid_phone"
    assert co._phone_failure_reason("some other error", 400) == "send_rejected"


def test_phone_verification_skips_on_auth_step_invalid(monkeypatch):
    """授权不在手机验证步骤时：取消号码、跳过手机步骤，不烧号重试。"""
    import core.sms_provider as sms_provider

    class FakeResp:
        status_code = 400
        text = "Invalid authorization step. invalid_request_error invalid_auth_step https://auth.openai.com/log-in"

    class FakeHttp:
        def close(self):
            pass

    acquired = []
    canceled = []

    monkeypatch.setattr(sms_provider, "_http", lambda: FakeHttp())
    monkeypatch.setattr(
        sms_provider, "acquire_number",
        lambda http: acquired.append(1) or ("a1", "16195550123"),
    )
    monkeypatch.setattr(sms_provider, "cancel", lambda aid, http: canceled.append(aid))
    monkeypatch.setattr(co, "_post_json", lambda session, url, payload, referer, **kw: FakeResp())

    co._do_phone_verification(object())
    assert acquired == [1]
    assert canceled == ["a1"]
