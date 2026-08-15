# -*- coding: utf-8 -*-
"""WebUI 配置页暴露 IMAP 服务器/端口（支持 163/Gmail 等收信邮箱）的回归测试。"""
import textwrap

import pytest

from webui import config_editor as CE


def _fields_by_key():
    return {f["key"]: f for f in CE.EDITABLE_FIELDS}


def test_imap_fields_exposed_in_editor():
    fields = _fields_by_key()
    for key in ("QQ_IMAP_SERVER", "QQ_IMAP_PORT"):
        assert key in fields, f"{key} 未暴露到 WebUI 配置页"
        assert fields[key]["file"] == "email.py"
        assert fields[key]["group"] == "邮箱 / OTP"
    assert fields["QQ_IMAP_SERVER"]["type"] == "str"
    assert fields["QQ_IMAP_PORT"]["type"] == "int"
    assert fields["QQ_IMAP_PORT"]["min"] == 1
    assert fields["QQ_IMAP_PORT"]["max"] == 65535


def test_email_source_fields_exposed_in_editor():
    """7 种邮箱来源的配置字段都暴露在「邮箱 / OTP」分组下。"""
    fields = _fields_by_key()
    expected = {
        "GPTMAIL_API_KEY": "str",
        "MAIL_NEST_API_KEY": "str",
        "MAIL_NEST_PROJECT_CODE": "str",
        "CLOUDFLARE_API_BASE": "str",
        "CLOUDFLARE_API_KEY": "str",
        "CLOUDFLARE_AUTH_MODE": "str",
        "CLOUDFLARE_CUSTOM_AUTH": "str",
        "CLOUDFLARE_DEFAULT_DOMAINS": "list_str_multiline",
        "CLOUDMAIL_API_BASE": "str",
        "CLOUDMAIL_ADMIN_EMAIL": "str",
        "CLOUDMAIL_PASSWORD": "str",
        "CLOUDMAIL_AUTH_TOKEN": "str",
        "CLOUDMAIL_DOMAINS": "list_str_multiline",
        "CLOUDMAIL_AUTO_ADD_USER": "bool",
        "CLOUDMAIL_RANDOM_LOCAL_LENGTH": "int",
    }
    for key, vtype in expected.items():
        assert key in fields, f"{key} 未暴露到 WebUI 配置页"
        assert fields[key]["file"] == "email.py"
        assert fields[key]["group"] == "邮箱 / OTP"
        assert fields[key]["type"] == vtype
    # 密钥类字段必须 secret，避免明文回显
    for key in ("GPTMAIL_API_KEY", "MAIL_NEST_API_KEY", "CLOUDFLARE_API_KEY",
                "CLOUDFLARE_CUSTOM_AUTH", "CLOUDMAIL_PASSWORD", "CLOUDMAIL_AUTH_TOKEN"):
        assert fields[key].get("secret") is True, f"{key} 应为 secret 字段"


def test_update_config_switches_to_163(tmp_path, monkeypatch):
    monkeypatch.setattr(CE, "_CONFIG_DIR", tmp_path)
    fake = tmp_path / "email.py"
    fake.write_text(
        textwrap.dedent(
            """\
            # 默认值
            QQ_IMAP_SERVER = "imap.qq.com"
            QQ_IMAP_PORT = 993
            """
        ),
        encoding="utf-8",
    )

    res = CE.update_config({"QQ_IMAP_SERVER": "imap.163.com", "QQ_IMAP_PORT": 995})
    assert set(res["updated"]) == {"QQ_IMAP_SERVER", "QQ_IMAP_PORT"}
    assert res["ignored"] == []

    source = fake.read_text(encoding="utf-8")
    assert 'QQ_IMAP_SERVER = "imap.163.com"' in source
    assert "QQ_IMAP_PORT = 995" in source

    # 读回：新值可从源码解析出来（前端表单回显）
    current = {item["key"]: item["value"] for item in CE.get_config()}
    assert current.get("QQ_IMAP_SERVER") == "imap.163.com"
    assert current.get("QQ_IMAP_PORT") == 995


def test_update_config_rejects_out_of_range_port(tmp_path, monkeypatch):
    monkeypatch.setattr(CE, "_CONFIG_DIR", tmp_path)
    (tmp_path / "email.py").write_text("QQ_IMAP_PORT = 993\n", encoding="utf-8")
    with pytest.raises(ValueError):
        CE.update_config({"QQ_IMAP_PORT": 0})
    with pytest.raises(ValueError):
        CE.update_config({"QQ_IMAP_PORT": 65536})


def test_replace_scalar_keeps_trailing_comment():
    source = 'QQ_IMAP_SERVER = "imap.qq.com"  # IMAP 服务器\n'
    out = CE._replace_scalar(source, "QQ_IMAP_SERVER", '"imap.163.com"')
    assert out == 'QQ_IMAP_SERVER = "imap.163.com"  # IMAP 服务器\n'
