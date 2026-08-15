# -*- coding: utf-8 -*-
"""Cloudflare 域名邮箱 IMAP 取信客户端的健壮性回归测试（163/QQ 等收信邮箱）。"""
import imaplib

import pytest

from core import qqmail_client as qc
from config import email as _email_cfg


def test_select_no_raises_with_server_text(monkeypatch):
    """SELECT 收件箱返回 NO 时必须显式报错（否则 SEARCH 会报 illegal in state AUTH）。"""
    class FakeIMAP:
        def __init__(self, server, port):
            self.server = server
            self.port = port

        def login(self, user, password):
            return ("OK", [])

        def select(self, folder):
            return ("NO", [b"[ALERT] login from new device"])

    monkeypatch.setattr(_email_cfg, "QQ_EMAIL", "a@163.com")
    monkeypatch.setattr(_email_cfg, "QQ_IMAP_PASSWORD", "authcode")
    monkeypatch.setattr(qc.imaplib, "IMAP4_SSL", FakeIMAP)

    with pytest.raises(qc.QQMailClientError, match="选择收件箱失败"):
        qc._connect_imap()


def test_search_state_error_retries_next_cycle(monkeypatch):
    """一轮 SEARCH 协议错误不应终止整个 OTP 等待，下一轮重连后应能取到验证码。"""
    class FakeMail:
        def logout(self):
            pass

    rounds = {"n": 0}

    def fake_connect():
        return FakeMail()

    def fake_search(mail, after_dt=None):
        rounds["n"] += 1
        if rounds["n"] == 1:
            raise imaplib.IMAP4.error("command SEARCH illegal in state AUTH, only allowed in states SELECTED")
        return [{
            "subject": "ChatGPT verification code",
            "from": "noreply@openai.com",
            "to": "a@524541577.xyz",
            "text": "Your verification code is 123456",
            "date": "2026-08-15T23:49:20Z",
        }]

    monkeypatch.setattr(qc, "_connect_imap", fake_connect)
    monkeypatch.setattr(qc, "_search_messages", fake_search)

    otp = qc.fetch_latest_otp(
        "a@524541577.xyz", after_ts=0, max_wait=6, poll_interval=1, settle_seconds=0,
    )
    assert otp == "123456"
    assert rounds["n"] >= 2
