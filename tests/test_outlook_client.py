# -*- coding: utf-8 -*-
"""Outlook 取件：远端服务不可用（402/Cloudflare 拦截）自动回退直连。"""
import pytest

from core import outlook_client as oc


def _challenge_403() -> str:
    return (
        "security-session 初始化失败 HTTP 403: <!DOCTYPE html><html lang=\"en-US\">"
        "<head><title>Just a moment...</title>"
    )


@pytest.mark.parametrize("text,expected", [
    ("DEPLOYMENT_DISABLED", True),
    ("secure_post HTTP 402: Payment required", True),
    (_challenge_403(), True),
    ("HTTP 403: cf-chl-blob", True),
    ("HTTP 403: forbidden", False),
    ("HTTP 500: boom", False),
    ("连接超时", False),
])
def test_is_remote_disabled_error(text, expected):
    assert oc._is_remote_disabled_error(text) is expected


def _account() -> oc.OutlookAccount:
    return oc.OutlookAccount(
        email="tester@outlook.com", password="pw", client_id="cid", refresh_token="rt"
    )


def test_fetch_via_auto_fallback_to_direct(monkeypatch):
    """auto 模式下远端被 Cloudflare 拦截 → 自动回退 Graph/IMAP 直连，不再空转。"""
    account = _account()

    def boom(_session, _url, _payload):
        raise oc.OutlookClientError(_challenge_403())

    monkeypatch.setattr(oc, "_secure_post", boom)
    monkeypatch.setattr(
        oc, "_fetch_via_graph_direct",
        lambda acc: [{**_account_dict(), "_fetch_source": "direct_graph"}],
    )
    monkeypatch.setattr(
        oc, "_fetch_imap_direct_messages",
        lambda acc: [{**_account_dict(), "_fetch_source": "direct_imap"}],
    )
    oc._REMOTE_DISABLED = False

    session = object()
    out_graph = oc._fetch_via(session, "graph", account)
    assert out_graph and out_graph[0]["_fetch_source"] == "direct_graph"
    assert oc._REMOTE_DISABLED is True

    # 第二次起不再请求远端，直接走直连
    out_imap = oc._fetch_via(session, "imap", account)
    assert out_imap and out_imap[0]["_fetch_source"] == "direct_imap"

    # 重置，避免影响其他用例
    oc._REMOTE_DISABLED = False


def test_fetch_via_direct_mode_never_calls_remote(monkeypatch):
    """direct 模式下完全不请求远端服务。"""
    account = _account()
    monkeypatch.setattr(oc, "_outlook_fetch_mode", lambda: "direct")
    monkeypatch.setattr(
        oc, "_fetch_via_graph_direct",
        lambda acc: [{**_account_dict(), "_fetch_source": "direct_graph"}],
    )

    def _should_not_call(*_a, **_k):
        raise AssertionError("direct 模式不应请求远端")

    monkeypatch.setattr(oc, "_secure_post", _should_not_call)
    oc._REMOTE_DISABLED = False
    out = oc._fetch_via(object(), "graph", account)
    assert out and out[0]["_fetch_source"] == "direct_graph"


def _account_dict() -> dict:
    return {"id": "1", "subject": "s", "from": "openai@example.com"}
