# -*- coding: utf-8 -*-
"""注册后设置密码（username_password_create 分支）单元测试。全程 mock，不发真实请求。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from core.openai_auth import auth_step_requires_password, register_user


class FakeResp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.text = str(payload)
        self.url = "https://auth.openai.com/..."

    def json(self):
        if not isinstance(self._payload, (dict, list)):
            raise ValueError(f"非 JSON 响应: {self.text[:80]}")
        return self._payload


class FakeSession:
    """记录请求的假 session。"""

    def __init__(self):
        self.posts = []  # (url, headers, data)
        self.gets = []
        self._resp = FakeResp({})

    def set_response(self, resp):
        self._resp = resp

    def get_auth_headers(self, referer=""):
        return {"referer": referer, "content-type": "application/json"}

    def get_auth_navigate_headers(self, referer=""):
        return {"referer": referer}

    def post(self, url, headers=None, data=None, **kw):
        self.posts.append((url, dict(headers or {}), data))
        return self._resp

    def get(self, url, headers=None, **kw):
        self.gets.append((url, dict(headers or {})))
        return self._resp


# ------------------------------------------------------------
# 分支判断
# ------------------------------------------------------------
def test_requires_password_positive():
    assert auth_step_requires_password("https://auth.openai.com/create-account/password", "") is True
    assert auth_step_requires_password("", "create_account_password") is True
    assert auth_step_requires_password("https://auth.openai.com/create-account/password", "password_page") is True
    # 大小写不敏感
    assert auth_step_requires_password("https://auth.openai.com/Create-Account/Password", "") is True


def test_requires_password_negative():
    assert auth_step_requires_password("https://auth.openai.com/about-you", "about_you") is False
    assert auth_step_requires_password("", "") is False
    assert auth_step_requires_password("https://auth.openai.com/email-otp/send", "email_otp_send") is False
    assert auth_step_requires_password(None, None) is False


# ------------------------------------------------------------
# register_user 请求构造
# ------------------------------------------------------------
def test_register_user_request_shape():
    sess = FakeSession()
    sess.set_response(FakeResp({"continue_url": "https://auth.openai.com/about-you", "page": {"type": "about_you"}}))
    result = register_user(sess, "user@example.com", "StrongPass@123", "sentinel-token-abc")

    assert len(sess.posts) == 1
    url, headers, body = sess.posts[0]
    assert url == "https://auth.openai.com/api/accounts/user/register"
    # 请求体：password + username
    import json as _json
    payload = _json.loads(body)
    assert payload == {"password": "StrongPass@123", "username": "user@example.com"}
    # 头：referer 指向密码页 + sentinel token
    assert headers["referer"] == "https://auth.openai.com/create-account/password"
    assert headers["openai-sentinel-token"] == "sentinel-token-abc"
    # 返回结构
    assert result["_http_status"] == 200
    assert result["page"]["type"] == "about_you"


def test_register_user_http_error_returns_dict():
    sess = FakeSession()
    sess.set_response(FakeResp({"error": {"code": "bad"}}, status_code=400))
    result = register_user(sess, "u@x.com", "pw12345678", "tok")
    assert result["_http_status"] == 400
    assert "error" in result


def test_register_user_non_json_response():
    sess = FakeSession()
    sess.set_response(FakeResp("<html>oops</html>", status_code=502))
    result = register_user(sess, "u@x.com", "pw12345678", "tok")
    assert result["_http_status"] == 502
    assert "text" in result


# ------------------------------------------------------------
# 配置接线：开关保存生效（不再是空开关）
# ------------------------------------------------------------
def test_config_switch_save_effect():
    from webui import config_editor as ce
    result = ce.update_config({"ENABLE_POST_REGISTER_PASSWORD": True})
    assert "ENABLE_POST_REGISTER_PASSWORD" in result["updated"], "开关保存应生效（不再 ignored）"
    # 恢复默认
    ce.update_config({"ENABLE_POST_REGISTER_PASSWORD": False})


def test_password_config_field_masked():
    from webui import config_editor as ce
    fields = {f["key"]: f for f in ce.get_config()}
    field = fields.get("POST_REGISTER_PASSWORD")
    assert field is not None, "POST_REGISTER_PASSWORD 应在配置白名单"
    assert field.get("secret") is True, "密码字段应标记 secret（掩码显示）"


# ------------------------------------------------------------
# 健壮性边界（畸形输入不崩溃）
# ------------------------------------------------------------
def test_requires_password_malformed_inputs():
    """任何畸形输入都不应抛异常。"""
    for bad in (None, 0, 1.5, ["x"], {"a": 1}, object(), b"bytes"):
        assert auth_step_requires_password(bad, "") in (True, False)
        assert auth_step_requires_password("", bad) in (True, False)
    # 超长输入
    assert auth_step_requires_password("password" * 20000, "") is True
    assert auth_step_requires_password("a" * 100000, "b" * 100000) is False
    # 特殊字符：URL 编码的 pass%20word 不算 password 子串；完整出现才算
    assert auth_step_requires_password("https://x/pass%20word", "") is False
    assert auth_step_requires_password("https://x/password/../about-you", "") is True


def test_register_user_json_array_response():
    """服务端返回合法 JSON 数组（异常但合法）→ 返回 list，不崩溃。"""
    sess = FakeSession()
    sess.set_response(FakeResp([1, 2, 3], status_code=200))
    result = register_user(sess, "u@x.com", "pw12345678", "tok")
    assert isinstance(result, list)  # 原样返回，调用方有 isinstance(dict) 防御


def test_register_user_empty_values():
    """空邮箱/空密码不应在本地抛异常（透传给上游）。"""
    sess = FakeSession()
    sess.set_response(FakeResp({"continue_url": "x"}, status_code=200))
    result = register_user(sess, "", "", "tok")
    assert result["_http_status"] == 200
    url, headers, body = sess.posts[0]
    import json as _json
    assert _json.loads(body) == {"password": "", "username": ""}


# ------------------------------------------------------------
# 注册配置边界（P1：0 注册数/0 并发拒绝）
# ------------------------------------------------------------
def test_register_workers_min_bound():
    from webui import config_editor as ce
    with pytest.raises(ValueError, match="不能小于 1"):
        ce.update_config({"REGISTER_WORKERS": 0})
    with pytest.raises(ValueError, match="不能小于 1"):
        ce.update_config({"REGISTER_BATCH_COUNT": 0})
    with pytest.raises(ValueError, match="不能小于 1"):
        ce.update_config({"REGISTER_WORKERS": -3})
    # 合法值可保存
    r = ce.update_config({"REGISTER_WORKERS": 2, "REGISTER_BATCH_COUNT": 5})
    assert "REGISTER_WORKERS" in r["updated"] and "REGISTER_BATCH_COUNT" in r["updated"]
    ce.update_config({"REGISTER_WORKERS": 3, "REGISTER_BATCH_COUNT": 1})


def test_register_birthday_has_default_value():
    """REGISTER_BIRTHDAY 已真实定义（默认 2000-01-01），不再是无定义占位字段。"""
    from webui import config_editor as ce
    fields = {f["key"]: f for f in ce.get_config()}
    assert fields["REGISTER_BIRTHDAY"]["value"] == "2000-01-01"
    assert fields["REGISTER_WORKERS"]["value"] >= 1
    assert fields["REGISTER_BATCH_COUNT"]["value"] >= 1
