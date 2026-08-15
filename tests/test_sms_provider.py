# -*- coding: utf-8 -*-
"""接码平台客户端单元测试：provider 自动选地址、请求构造、响应解析（全程 mock，不发真实请求）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from core import sms_provider as sp
from config import codex as cfg


class FakeResponse:
    def __init__(self, text, status_code=200):
        self.text = text
        self.status_code = status_code


class FakeSession:
    """记录请求的假 session；按顺序返回预置响应。"""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []  # (url, params)
        self.closed = False

    def get(self, url, params=None, **kw):
        self.calls.append((url, dict(params or {})))
        if self.responses:
            return self.responses.pop(0)
        return FakeResponse("NO_NUMBERS")

    def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def reset_config(monkeypatch):
    """每个用例恢复默认配置并隔离 _ACQUIRED_AT。"""
    monkeypatch.setattr(cfg, "SMS_PROVIDER", "grizzly")
    monkeypatch.setattr(cfg, "SMS_API_BASE", "")
    monkeypatch.setattr(cfg, "SMS_API_KEY", "test-key")
    monkeypatch.setattr(cfg, "SMS_SERVICE", "openai")
    monkeypatch.setattr(cfg, "SMS_COUNTRY", "10")
    monkeypatch.setattr(cfg, "SMS_MAX_PRICE", "")
    monkeypatch.setattr(sp, "_ACQUIRED_AT", {})
    yield


# ------------------------------------------------------------
# API 地址自动选择
# ------------------------------------------------------------
def test_api_base_auto_select():
    cfg.SMS_API_BASE = ""
    cfg.SMS_PROVIDER = "grizzly"
    assert sp._api_base() == "https://api.grizzlysms.com/stubs/handler_api.php"
    cfg.SMS_PROVIDER = "hero"
    assert sp._api_base() == "https://hero-sms.com/stubs/handler_api.php"
    cfg.SMS_PROVIDER = "smsbower"
    assert sp._api_base() == "https://smsbower.page/stubs/handler_api.php"
    # 显式配置的 SMS_API_BASE 始终优先
    cfg.SMS_API_BASE = "https://my-custom.example/handler_api.php"
    assert sp._api_base() == "https://my-custom.example/handler_api.php"
    # 平台子页同步写入的其他平台地址必须保留（避免 hero key 错发到 grizzly）
    cfg.SMS_PROVIDER = "smsbower"
    cfg.SMS_API_BASE = "https://hero-sms.com/stubs/handler_api.php"
    assert sp._api_base() == "https://hero-sms.com/stubs/handler_api.php"


def test_provider_name_map():
    cfg.SMS_PROVIDER = "smsbower"
    assert sp._provider_name() == "SMSBower"
    cfg.SMS_PROVIDER = "unknown_thing"
    assert sp._provider_name() == "unknown_thing"


# ------------------------------------------------------------
# 请求构造
# ------------------------------------------------------------
def test_acquire_smsbower_request_shape():
    """SMSBower 取号：请求 smsbower.page + api_key/action/service/country 参数。"""
    cfg.SMS_PROVIDER = "smsbower"
    sess = FakeSession(FakeResponse("ACCESS_NUMBER:12345:16195366483"))
    monkeypatch_http(sess)
    activation_id, phone = sp.acquire_number()
    url, params = sess.calls[0]
    assert url == "https://smsbower.page/stubs/handler_api.php"
    assert params["api_key"] == "test-key"
    assert params["action"] == "getNumber"
    assert params["service"] == "openai"
    assert params["country"] == "10"
    assert activation_id == "12345"
    assert phone == "16195366483"


def test_acquire_includes_max_price():
    cfg.SMS_PROVIDER = "smsbower"
    cfg.SMS_MAX_PRICE = "5"
    sess = FakeSession(FakeResponse("ACCESS_NUMBER:1:7912345678"))
    monkeypatch_http(sess)
    sp.acquire_number()
    assert sess.calls[0][1].get("maxPrice") == "5"


def test_acquire_custom_base_wins():
    cfg.SMS_PROVIDER = "smsbower"
    cfg.SMS_API_BASE = "https://mirror.smsbower.page/stubs/handler_api.php"
    sess = FakeSession(FakeResponse("ACCESS_NUMBER:1:7912345678"))
    monkeypatch_http(sess)
    sp.acquire_number()
    assert sess.calls[0][0] == "https://mirror.smsbower.page/stubs/handler_api.php"


# ------------------------------------------------------------
# 公共错误码 → 异常映射
# ------------------------------------------------------------
def test_common_error_codes(monkeypatch):
    cfg.SMS_PROVIDER = "smsbower"
    cases = [
        ("BAD_KEY", sp.SmsProviderError, "API key 无效"),
        ("NO_BALANCE", sp.SmsNoBalanceError, "余额不足"),
        ("NO_NUMBERS", sp.SmsNoNumbersError, "暂无可用号码"),
        ("BAD_ACTION", sp.SmsProviderError, "请求参数错误"),
        ("The service is prohibited for your country", sp.SmsProviderError, "禁售"),
    ]
    for text, exc_type, keyword in cases:
        sess = FakeSession(FakeResponse(text))
        monkeypatch_http(sess)
        with pytest.raises(exc_type, match=keyword):
            sp.acquire_number()


def test_http_error_surfaces_provider_name():
    cfg.SMS_PROVIDER = "smsbower"
    sess = FakeSession(FakeResponse("oops", status_code=502))
    monkeypatch_http(sess)
    with pytest.raises(sp.SmsProviderError, match="SMSBower HTTP 502"):
        sp.acquire_number()


# ------------------------------------------------------------
# 等短信 / 状态流转
# ------------------------------------------------------------
def test_wait_for_sms_code(monkeypatch):
    cfg.SMS_PROVIDER = "smsbower"
    sess = FakeSession(
        FakeResponse("STATUS_WAIT_CODE"),
        FakeResponse("STATUS_OK:123456"),
    )
    monkeypatch_http(sess)
    monkeypatch.setattr(sp, "_cfg", cfg)
    code = sp.wait_for_sms_code("12345", http=sess, max_wait=3, poll_interval=0.01)
    assert code == "123456"
    # getStatus 请求构造正确
    assert sess.calls[0][1]["action"] == "getStatus"
    assert sess.calls[0][1]["id"] == "12345"


def test_wait_timeout(monkeypatch):
    cfg.SMS_PROVIDER = "smsbower"
    # 一直返回 WAIT_CODE，直到轮询超时
    sess = FakeSession(*[FakeResponse("STATUS_WAIT_CODE") for _ in range(200)])
    monkeypatch_http(sess)
    with pytest.raises(sp.SmsCodeTimeout):
        sp.wait_for_sms_code("1", http=sess, max_wait=1, poll_interval=0.01)


def test_set_status_shape(monkeypatch):
    cfg.SMS_PROVIDER = "smsbower"
    sess = FakeSession(FakeResponse("ACCESS_READY"))
    monkeypatch_http(sess)
    result = sp.set_status("12345", 6, http=sess)
    assert result == "ACCESS_READY"
    assert sess.calls[0][1]["action"] == "setStatus"
    assert sess.calls[0][1]["id"] == "12345"
    assert sess.calls[0][1]["status"] == "6"


# ------------------------------------------------------------
# 工具
# ------------------------------------------------------------
def monkeypatch_http(sess):
    sp._http = lambda: sess


# ------------------------------------------------------------
# _api_base：平台切换时地址不能错配
# ------------------------------------------------------------
def test_api_base_empty_uses_provider_default(monkeypatch):
    monkeypatch.setattr(cfg, "SMS_PROVIDER", "grizzly")
    monkeypatch.setattr(cfg, "SMS_API_BASE", "")
    assert sp._api_base() == sp._DEFAULT_BASES["grizzly"]


def test_api_base_other_platform_url_is_kept(monkeypatch):
    """平台子页同步写入 hero 地址 + 通道 grizzly 时，地址必须保留，不能替换成 grizzly 默认。"""
    monkeypatch.setattr(cfg, "SMS_PROVIDER", "grizzly")
    monkeypatch.setattr(cfg, "SMS_API_BASE", sp._DEFAULT_BASES["hero"])
    assert sp._api_base() == sp._DEFAULT_BASES["hero"]


def test_api_base_matching_default_is_default(monkeypatch):
    monkeypatch.setattr(cfg, "SMS_PROVIDER", "hero")
    monkeypatch.setattr(cfg, "SMS_API_BASE", sp._DEFAULT_BASES["hero"])
    assert sp._api_base() == sp._DEFAULT_BASES["hero"]


def test_api_base_custom_url_kept(monkeypatch):
    monkeypatch.setattr(cfg, "SMS_PROVIDER", "grizzly")
    monkeypatch.setattr(cfg, "SMS_API_BASE", "https://my.custom.handler/api.php")
    assert sp._api_base() == "https://my.custom.handler/api.php"
